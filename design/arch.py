"""画一张「现在 vs 3.0」的架构图。纯 Pillow，不依赖浏览器。"""

from PIL import Image, ImageDraw, ImageFont

W, H = 1760, 1240
BG = (248, 249, 251)
INK = (31, 36, 48)
SUB = (107, 116, 130)
BLUE = (74, 134, 212)
AMBER = (221, 143, 34)
GREEN = (47, 158, 95)
PURPLE = (132, 89, 200)
GREY = (154, 163, 178)
RED = (200, 60, 60)

FONT = "C:/Windows/Fonts/msyh.ttc"
font_title = ImageFont.truetype(FONT, 34)
font_panel = ImageFont.truetype(FONT, 23)
font_box = ImageFont.truetype(FONT, 18)
font_body = ImageFont.truetype(FONT, 15)
font_small = ImageFont.truetype(FONT, 13)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)


def box(x, y, w, h, title, lines, color, fill, dashed=False, title_color=None):
    if dashed:
        # 手绘虚线框
        step = 10
        for xx in range(x, x + w, step * 2):
            d.line([(xx, y), (min(xx + step, x + w), y)], fill=color, width=2)
            d.line([(xx, y + h), (min(xx + step, x + w), y + h)], fill=color, width=2)
        for yy in range(y, y + h, step * 2):
            d.line([(x, yy), (x, min(yy + step, y + h))], fill=color, width=2)
            d.line([(x + w, yy), (x + w, min(yy + step, y + h))], fill=color, width=2)
    else:
        d.rounded_rectangle([x, y, x + w, y + h], radius=12, fill=fill, outline=color, width=2)
    d.text((x + 18, y + 14), title, font=font_box, fill=title_color or INK)
    ty = y + 46
    for line in lines:
        d.text((x + 18, ty), line, font=font_body, fill=(60, 68, 82))
        ty += 24
    return (x, y, w, h)


def arrow(x1, y1, x2, y2, color, dashed=False, label="", width=2):
    if dashed:
        # 虚线
        import math
        dist = math.hypot(x2 - x1, y2 - y1)
        if dist == 0:
            return
        ux, uy = (x2 - x1) / dist, (y2 - y1) / dist
        pos = 0
        while pos < dist - 12:
            a = (x1 + ux * pos, y1 + uy * pos)
            b = (x1 + ux * min(pos + 8, dist - 12), y1 + uy * min(pos + 8, dist - 12))
            d.line([a, b], fill=color, width=width)
            pos += 16
    else:
        d.line([(x1, y1), (x2, y2)], fill=color, width=width)
    # 箭头
    import math
    ang = math.atan2(y2 - y1, x2 - x1)
    size = 12
    for s in (+0.42, -0.42):
        d.line([(x2, y2), (x2 - size * math.cos(ang + s), y2 - size * math.sin(ang + s))], fill=color, width=width)
    if label:
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        tw = d.textlength(label, font=font_small)
        d.rectangle([mx - tw / 2 - 6, my - 10, mx + tw / 2 + 6, my + 10], fill=BG)
        d.text((mx - tw / 2, my - 8), label, font=font_small, fill=color)


# ---------------- 标题 ----------------
d.text((60, 34), "拟真控制终端 · 架构（现在 vs 3.0）", font=font_title, fill=INK)
d.text((60, 82), "2026-11-17 · 手机：Honor BKL-AL20 / Android 10 / 微信 8.0.80", font=font_small, fill=SUB)

# ================= 面板一：现在 =================
d.text((60, 120), "① 现在（2.x 旧插件在跑，引擎已停）", font=font_panel, fill=AMBER)
# DSH
box(60, 160, 560, 300, "DSH 进程", [
    "插件 dsh-wechat-usb 2.x（6800 行）",
    "  · 12 个工具（wechat_*）",
    "  · 设置页 / 状态 API 65470",
    "  · lib/poller.js 3000 行：感知+规则+导航",
    "  · schedule.create 叫醒会话 → 主模型回话",
    "  · 自己直接调 adb 操作手机",
], AMBER, (255, 246, 232))

# 引擎（停）
box(660, 160, 470, 300, "mimicd 引擎（daemon 已停）", [
    "device / perception / world / policy",
    "skills / actuator / pending / events",
    "HTTP 65480：/state /pending /intent …",
    "能力已实测：表情、读链接、精确读、标题核对",
], GREY, (244, 245, 248), dashed=True, title_color=GREY)

# 手机
box(1170, 160, 520, 300, "手机", [
    "微信 8.0.80",
    "mimic-injector.dex（app_process，TCP 7801）",
    "MimicProbe APK（触摸探针 + 无键盘输入法）",
    "ADBKeyboard（日常输入法）",
], GREEN, (233, 247, 239))

arrow(620, 310, 1170, 310, AMBER, label="ADB / 截图 / 注入（唯一执行者）")
arrow(1130, 400, 660, 400, GREY, dashed=True, label="未接通（引擎已停）")

# ================= 面板二：3.0 =================
d.text((60, 520), "② 3.0 目标（插件变薄壳，引擎独占手机）", font=font_panel, fill=BLUE)

# 插件 3.0
box(60, 560, 470, 330, "DSH 插件 3.0（薄壳）", [
    "· 工具面 wechat_*（名字不变）",
    "· 设置页 / 状态面板",
    "· bridge：轮询 /pending",
    "     └ schedule.create 叫醒会话",
    "· 模型回话 → POST /pending/reply",
    "",
    "不再直接碰 adb；不搬感知与规则",
], BLUE, (234, 242, 253))

# 引擎
box(590, 560, 660, 330, "mimicd 引擎（唯一执行者）", [
    "perception：页面判定 / 稳定帧 / OCR / 气泡颜色",
    "monitor：红点扫列表 → 进会话 → 读尾部",
    "world：会话状态 + 多重集去重 + 上下文",
    "policy：静默时段 / 冷却 / 频率（硬规则）",
    "handoff：把「该回了」挂成待办（/pending）",
    "skills：send_text / send_sticker / read_link …",
    "events：JSONL 落盘 + replay 复盘",
], BLUE, (244, 248, 255))

# 手机
box(1310, 560, 380, 330, "手机", [
    "微信 8.0.80",
    "injector（触摸）",
    "MimicProbe（输入法）",
], GREEN, (233, 247, 239))

arrow(1010, 620, 1310, 620, GREEN, label="ADB")
arrow(530, 700, 590, 700, BLUE, label="HTTP 65480")
arrow(590, 760, 530, 760, BLUE, label="待办 → 唤醒")

# 主模型
box(60, 960, 470, 190, "DSH 会话（主模型 = 脑子）", [
    "读上下文 → 决定：",
    "  回文本 / 回表情 / 沉默（带理由）",
    "回话经插件 → 引擎执行发送",
    "记忆与人格留在这里，不落在引擎里",
], PURPLE, (246, 240, 253))
arrow(295, 890, 295, 960, PURPLE, label="schedule.create")
arrow(530, 1055, 590, 1055, PURPLE, label="reply")

# 使用方式
d.text((700, 980), "引擎怎么用（命令行）", font=font_panel, fill=INK)
cmds = [
    "node tools/inject/deploy.ts --adb <adb>     起注入器",
    "node tools/ime-mode.ts --adb <adb> on       切输入法（用完 off）",
    "node tools/run-skill.ts --skill …           跑单个技能",
    "node tools/daemon.ts --interval 20          监控 + 交接",
    "node tools/reply-pending.ts --list          看待办",
    "node tools/replay.ts <run.jsonl>            回放复盘",
]
cy = 1028
for c in cmds:
    d.text((700, cy), c, font=font_body, fill=(60, 68, 82))
    cy += 30

d.text((60, 1190), "端口：注入器 7801（adb forward）· 引擎 HTTP 65480 · 旧插件状态 65470", font=font_small, fill=SUB)

img.save("design/arch-now-and-3.0.png")
print("saved design/arch-now-and-3.0.png", img.size)