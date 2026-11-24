#!/usr/bin/env python3
# 抓取双色球、大乐透的全部历史开奖号码，校验后写入 web/data/ssq.json 和 web/data/dlt.json（网页“深度思考”用）
# 数据来源：500.com 提供的开奖 XML（每期一行：期号、开奖号码、开奖时间），比解析网页表格更直接可靠。
# 新开奖按开奖日、期号连续、日期先后检查，已有的历史不允许变化，
# 任何一项不通过就报错退出，不写入。
# 只用 Python 标准库，GitHub Actions 全天每 5 分钟运行一次。
# 退出码：0 成功（有没有新数据都算）；75 暂时连不上数据源，下一轮再试；1 校验不通过或数据太久没更新
import json  # 读写 JSON
import re  # 解析 XML 的每一行
import sys  # 退出码
import time  # 重试前等待
import urllib.request  # 下载网页
from datetime import datetime, timezone, timedelta  # 记录更新时间（北京时间）
from pathlib import Path  # 文件路径

# 两种彩票：开奖 XML 地址、红球个数和范围、蓝球个数和范围、第一期期号
GAMES = {  # 彩种配置
    "ssq": {"name": "双色球", "url": "https://kaijiang.500.com/static/info/kaijiang/xml/ssq/list.xml", "red": (6, 33), "blue": (1, 16), "first": "2003001",  # 双色球：6 红（1～33）+ 1 蓝（1～16）
            "weekdays": {1, 3, 6}},  # 开奖日：周二、四、日（Python 里周一为 0）
    "dlt": {"name": "大乐透", "url": "https://kaijiang.500.com/static/info/kaijiang/xml/dlt/list.xml", "red": (5, 35), "blue": (2, 12), "first": "2007001",  # 大乐透：5 红（1～35）+ 2 蓝（1～12）
            "weekdays": {0, 2, 5}},  # 开奖日：周一、三、六
}
OUT = Path(__file__).resolve().parent.parent / "web" / "data"  # 输出目录：网站文件夹 web 里的 data


class TempFail(Exception):  # 暂时连不上数据源（网络问题），这一轮跳过，下一轮再试
    pass


STALE_DAYS = 4  # 两种彩票最长隔 3 天开一次奖；本地数据最新一期超过 4 天，说明漏了开奖、连不上的时间太长，要报错


def fetch(url, tries=3):  # 下载并按 UTF-8 解码；网络偶尔断开时等一会儿再试，最多 3 次（连不上时一个彩种最多耗约 2 分钟，整轮赶在下一轮 5 分钟之前结束）
    # 用 Python 默认的标识如实访问，不伪装成浏览器
    for attempt in range(1, tries + 1):  # 第几次
        try:  # 尝试下载
            with urllib.request.urlopen(url, timeout=30) as resp:  # 最多等 30 秒（正常一两秒就下载完）
                return resp.read().decode("utf-8")  # XML 是 UTF-8
        except OSError as error:  # 连接被重置、超时、服务器出错等网络问题
            if attempt == tries:  # 最后一次也失败
                raise TempFail(f"连不上 {url}（{error}）") from error  # 当作暂时的问题，交给调用方处理
            time.sleep(5 * attempt)  # 等 5 秒、10 秒再试


def parse(xml, game):  # 从开奖 XML 里取出每一期：期号、日期、红球、蓝球
    # 每期一行，例如 <row expect="26133" opencode="07,10,11,14,21,26|13" opentime="2026-11-19 21:15:00" .../>
    # 只用正则读属性，不解析 XML 实体，外部数据里有恶意构造的内容也不会出问题
    red_n, blue_n = game["red"][0], game["blue"][0]  # 红球、蓝球个数
    draws = []  # 结果
    for row in re.findall(r"<row\b([^>]*)/?>", xml):  # 每一期
        attr = dict(re.findall(r'(\w+)="([^"]*)"', row))  # 这一行的属性
        expect, code, opened = attr.get("expect", ""), attr.get("opencode", ""), attr.get("opentime", "")  # 期号、号码、开奖时间
        assert re.fullmatch(r"\d{5}", expect), f"{game['name']}期号格式不对：{expect!r}"  # 期号是 5 位数字，如 26133
        assert re.fullmatch(r"\d+(,\d+)*\|\d+(,\d+)*", code), f"{game['name']}第 {expect} 期号码格式不对：{code!r}"  # 红球|蓝球
        assert re.match(r"\d{4}-\d{2}-\d{2}", opened), f"{game['name']}第 {expect} 期开奖时间格式不对：{opened!r}"  # 以日期开头
        red, blue = ([int(n) for n in part.split(",")] for part in code.split("|"))  # 红球、蓝球
        assert len(red) == red_n and len(blue) == blue_n, f"{game['name']}第 {expect} 期号码个数不对：{code}"  # 个数要对
        draws.append({"issue": "20" + expect, "date": opened[:10], "red": sorted(red), "blue": sorted(blue)})  # 期号补上世纪前缀，如 26133 → 2026133；号码从小到大
    return draws  # 新的在前


def validate(draws, game):  # 校验：号码个数、范围、不重复、从小到大；期号唯一且递减；日期格式正确且随期号递增
    (red_n, red_max), (blue_n, blue_max) = game["red"], game["blue"]  # 规则
    assert len(draws) > 1000, f"{game['name']} 只有 {len(draws)} 期，数据源可能有变化"  # 期数太少说明解析出了问题
    assert draws[-1]["issue"] == game["first"], f"{game['name']} 第一期应为 {game['first']}，实际 {draws[-1]['issue']}"  # 历史要从第一期开始
    seen = set()  # 出现过的期号
    for i, d in enumerate(draws):  # 每一期
        for key, n, top in (("red", red_n, red_max), ("blue", blue_n, blue_max)):  # 红球、蓝球
            v = d[key]  # 号码
            assert len(v) == n and all(1 <= x <= top for x in v), f"{d['issue']} {key} 号码不合规则：{v}"  # 个数和范围
            assert v == sorted(set(v)), f"{d['issue']} {key} 号码重复或未排序：{v}"  # 不重复、从小到大
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", d["date"]), f"{d['issue']} 日期格式不对：{d['date']}"  # 日期格式
        assert d["issue"] not in seen, f"期号重复：{d['issue']}"  # 期号不重复
        seen.add(d["issue"])  # 记下
        if i:  # 与上一行（更新的一期）比较
            assert d["issue"] < draws[i - 1]["issue"] and d["date"] <= draws[i - 1]["date"], f"{d['issue']} 顺序不对"  # 期号递减、日期不增


def check_new(draws, old_rows, game):  # 新开奖的检查：开奖日、期号连续、日期先后、不在未来
    known = {r[0] for r in old_rows}  # 已有的期号
    today = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")  # 北京时间今天
    new = [d for d in draws if d["issue"] not in known]  # 新开的期
    for d in new:  # 每一期新开奖
        i = draws.index(d)  # 在全部数据里的位置（新的在前）
        prev = draws[i + 1]  # 上一期
        assert d["date"] <= today, f"{game['name']}第 {d['issue']} 期日期 {d['date']} 在未来"  # 不能在未来
        assert d["date"] > prev["date"], f"{game['name']}第 {d['issue']} 期日期没有晚于上一期"  # 日期要往后
        weekday = datetime.strptime(d["date"], "%Y-%m-%d").weekday()  # 星期几（周一为 0）
        assert weekday in game["weekdays"], f"{game['name']}第 {d['issue']} 期开奖日 {d['date']} 不是开奖的星期"  # 必须是开奖日
        year, num = d["issue"][:4], int(d["issue"][4:])  # 年份和当年的序号
        if year == prev["issue"][:4]:  # 同一年
            assert num == int(prev["issue"][4:]) + 1, f"{game['name']}第 {d['issue']} 期期号不连续（上一期 {prev['issue']}）"  # 序号加一
        else:  # 跨年
            assert num == 1 and year == d["date"][:4], f"{game['name']}第 {d['issue']} 期跨年期号不对"  # 新一年从 001 开始
    return new  # 返回新开的期


def main():  # 抓取、校验、写入
    beijing = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")  # 北京时间
    for key, game in GAMES.items():  # 每种彩票
        draws = parse(fetch(game["url"]), game)  # 抓取并解析
        validate(draws, game)  # 校验，不通过就报错退出，不覆盖旧数据
        rows = [[d["issue"], d["date"], d["red"], d["blue"]] for d in draws]  # 紧凑格式：[期号, 日期, 红球, 蓝球]
        path = OUT / f"{key}.json"  # 输出文件
        old = json.loads(path.read_text("utf-8")) if path.exists() else None  # 旧数据
        if old:  # 已有旧数据时
            assert rows[len(rows) - len(old["draws"]):] == old["draws"], f"{game['name']}的历史开奖和上次不一样（数据源改动了历史？）"  # 旧的期不能变
            check_new(draws, old["draws"], game)  # 检查新开的期
        if old and old["draws"] == rows:  # 没有新的开奖
            print(f"{game['name']}：没有新数据（最新 {rows[0][0]} 期）")  # 提示
            continue  # 不改文件
        data = {"game": key, "name": game["name"], "source": "500.com", "updated": beijing, "count": len(rows), "draws": rows}  # 新数据
        OUT.mkdir(exist_ok=True)  # 确保目录存在
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")  # 紧凑写入
        print(f"{game['name']}：{len(rows)} 期，最新 {rows[0][0]} 期（{rows[0][1]}）")  # 提示


def stale_days():  # 本地数据最新一期离今天（北京时间）几天：取两种彩票里最旧的；没有数据时当作很久
    today = datetime.now(timezone(timedelta(hours=8))).date()  # 今天
    worst = 0  # 最多几天
    for key in GAMES:  # 每种彩票
        path = OUT / f"{key}.json"  # 数据文件
        if not path.exists():  # 还没有数据
            return 999  # 很久
        latest = json.loads(path.read_text("utf-8"))["draws"][0][1]  # 最新一期的日期
        worst = max(worst, (today - datetime.strptime(latest, "%Y-%m-%d").date()).days)  # 离今天几天
    return worst  # 最旧的那个


def run():  # 执行并返回退出码
    try:  # 尝试
        main()  # 抓取、校验、写入
        return 0  # 成功
    except TempFail as error:  # 暂时连不上
        days = stale_days()  # 数据多久没更新了
        if days > STALE_DAYS:  # 太久了：不再当作暂时的问题
            print(f"更新失败：{error}；本地数据最新一期已经是 {days} 天前，连不上的时间太长了", file=sys.stderr)  # 打印原因
            return 1  # 标记失败
        print(f"暂时连不上数据源，这一轮跳过，下一轮再试：{error}", file=sys.stderr)  # 打印原因
        return 75  # 暂时失败（工作流里当作提醒，不算失败）
    except Exception as error:  # 校验不通过等其他错误
        print(f"更新失败：{error}", file=sys.stderr)  # 打印原因
        return 1  # 非零退出，GitHub Actions 会标记失败


if __name__ == "__main__":  # 直接运行时
    sys.exit(run())  # 用退出码告诉工作流结果
