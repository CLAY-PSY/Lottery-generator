#!/usr/bin/env python3
# 抓取双色球、大乐透的全部历史开奖号码，校验后写入 data/ssq.json 和 data/dlt.json（网页“深度思考”用）
# 数据来源：全部来自 500.com 历史开奖页面。新开奖按开奖日、期号连续、日期先后检查，已有的历史不允许变化，
# 任何一项不通过就报错退出，不写入。
# 只用 Python 标准库，GitHub Actions 每天运行
import json  # 读写 JSON
import re  # 解析网页
import sys  # 退出码
import time  # 重试前等待
import urllib.request  # 下载网页
from datetime import datetime, timezone, timedelta  # 记录更新时间（北京时间）
from pathlib import Path  # 文件路径

# 两种彩票：页面地址、红球个数和范围、蓝球个数和范围、第一期期号
GAMES = {  # 彩种配置
    "ssq": {"name": "双色球", "url": "https://datachart.500.com/ssq/history/newinc/history.php?start=03001&end=99999", "red": (6, 33), "blue": (1, 16), "first": "2003001",  # 双色球：6 红（1～33）+ 1 蓝（1～16）
            "weekdays": {1, 3, 6}},  # 开奖日：周二、四、日（Python 里周一为 0）
    "dlt": {"name": "大乐透", "url": "https://datachart.500.com/dlt/history/newinc/history.php?start=07001&end=99999", "red": (5, 35), "blue": (2, 12), "first": "2007001",  # 大乐透：5 红（1～35）+ 2 蓝（1～12）
            "weekdays": {0, 2, 5}},  # 开奖日：周一、三、六
}
OUT = Path(__file__).resolve().parent.parent / "data"  # 输出目录：仓库根目录下的 data


def fetch(url, tries=3):  # 下载网页并按 UTF-8 解码；网络偶尔断开时等一会儿再试，最多 3 次
    # 用 Python 默认的标识如实访问，不伪装成浏览器
    for attempt in range(1, tries + 1):  # 第几次
        try:  # 尝试下载
            with urllib.request.urlopen(url, timeout=60) as resp:  # 最多等 60 秒
                return resp.read().decode("utf-8")  # 页面是 UTF-8
        except OSError:  # 连接被重置、超时等网络问题
            if attempt == tries:  # 最后一次也失败
                raise  # 交给调用方处理
            time.sleep(10 * attempt)  # 等 10 秒、20 秒再试


def parse(html, game):  # 从页面表格里取出每一期：期号、日期、红球、蓝球
    red_n, blue_n = game["red"][0], game["blue"][0]  # 红球、蓝球个数
    draws = []  # 结果
    for row in re.findall(r'<tr class="t_tr1">(.*?)</tr>', html, re.S):  # 每一行开奖记录
        cells = [re.sub(r"<[^>]+>|&nbsp;", "", c).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]  # 去掉标签后的单元格
        if len(cells) < 3 + red_n + blue_n or not re.fullmatch(r"\d{5}", cells[1]):  # 不是开奖记录（例如表头）
            continue  # 跳过
        nums = [int(c) for c in cells[2:2 + red_n + blue_n]]  # 红球和蓝球
        date = cells[-1]  # 最后一列是开奖日期
        draws.append({"issue": "20" + cells[1], "date": date, "red": nums[:red_n], "blue": nums[red_n:]})  # 期号补上世纪前缀，如 26133 → 2026133
    return draws  # 新的在前


def validate(draws, game):  # 校验：号码个数、范围、不重复、从小到大；期号唯一且递减；日期格式正确且随期号递增
    (red_n, red_max), (blue_n, blue_max) = game["red"], game["blue"]  # 规则
    assert len(draws) > 1000, f"{game['name']} 只有 {len(draws)} 期，页面可能有变化"  # 期数太少说明解析出了问题
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


if __name__ == "__main__":  # 直接运行时
    try:  # 尝试
        main()  # 执行
    except Exception as error:  # 出错
        print(f"更新失败：{error}", file=sys.stderr)  # 打印原因
        sys.exit(1)  # 非零退出，GitHub Actions 会标记失败
