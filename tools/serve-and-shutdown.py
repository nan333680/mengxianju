#!/usr/bin/env python3
r"""
构建完成后把 APK 送到手机，并在【真正传输完成】后自动关机。

为什么必须这么写：
  · 电脑一关机，HTTP 服务就没了。所以顺序只能是「先送包、后关机」。
  · 判定完成要覆写 copyfile —— 它是整个文件写完才返回的；
    传输中途断开会抛异常，走不到触发逻辑，不会把半截包当成送达。

环境变量（全部可省略）：
  MXJ_SERVE_DIR      共享目录，默认 桌面\mxj
  MXJ_SERVE_PORT     端口，默认 8899
  MXJ_SHUTDOWN_GRACE 下载完成后延迟多少秒关机，默认 60
  MXJ_SHUTDOWN_IDLE  兜底：多少秒无人下载也关机，默认 14400（4h）；设 0 = 永不兜底
"""
import ctypes
import http.server
import os
import socketserver
import subprocess
import threading
import time
from pathlib import Path

ROOT     = Path(os.environ.get('MXJ_SERVE_DIR') or (Path.home() / 'Desktop' / 'mxj'))
PORT     = int(os.environ.get('MXJ_SERVE_PORT') or 8899)
GRACE    = int(os.environ.get('MXJ_SHUTDOWN_GRACE') or 60)
IDLE_MAX = int(os.environ.get('MXJ_SHUTDOWN_IDLE') or 14400)
LOG      = Path(os.environ.get('TEMP') or '.') / 'mxj-serve.log'

STATE = {'fired': False}
LOCK  = threading.Lock()


def log(msg):
    line = time.strftime('%H:%M:%S ') + msg
    print(line, flush=True)
    try:
        with LOG.open('a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass


def keep_awake():
    """禁止系统因空闲进入睡眠。注意：合盖是电源策略，这个拦不住。"""
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
    try:
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        log('已禁止空闲睡眠')
    except Exception as e:
        log('禁止睡眠失败: %s' % e)


def do_shutdown(reason):
    try:
        # ⚠️ 先撤销可能已经挂着的关机（比如睡前设的 1 小时兜底）。
        #    Windows 同时只允许一个挂起安排，不撤销的话 shutdown 会以
        #    1190「A system shutdown has already been scheduled」拒绝，
        #    下载完成那 60 秒就永远不生效，得干等满 1 小时。
        subprocess.run(['shutdown', '/a'], check=False, capture_output=True)
        subprocess.run(['shutdown', '/s', '/t', str(GRACE), '/c', reason],
                       check=False, capture_output=True)
        log('已安排关机：%d 秒后（shutdown /a 可撤销）' % GRACE)
    except Exception as e:
        log('关机命令失败: %s' % e)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def copyfile(self, source, outputfile):
        # 这里返回，意味着整个文件已经写进 socket；中途断开会抛异常走到外面
        super().copyfile(source, outputfile)
        if self.path.lower().split('?')[0].endswith('.apk'):
            with LOCK:
                if STATE['fired']:
                    return
                STATE['fired'] = True
            log('APK 传输完成：%s（来自 %s）' % (self.path, self.client_address[0]))
            do_shutdown('梦弦居安装包已送达，电脑即将关机')

    def log_message(self, fmt, *args):
        log('%s - %s' % (self.address_string(), fmt % args))


def watchdog():
    """兜底：长时间没人来下，也不能一直开着过夜。"""
    start = time.time()
    while True:
        time.sleep(5)
        with LOCK:
            if STATE['fired']:
                return
        if IDLE_MAX and time.time() - start > IDLE_MAX:
            with LOCK:
                if STATE['fired']:
                    return
                STATE['fired'] = True
            log('兜底：%d 秒内无人下载，仍然关机（包留在桌面，可插线安装）' % IDLE_MAX)
            do_shutdown('无人下载，兜底关机')
            return


def main():
    if not ROOT.is_dir():
        log('共享目录不存在：%s' % ROOT)
        return 1
    keep_awake()
    threading.Thread(target=watchdog, daemon=True).start()

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('0.0.0.0', PORT), Handler) as httpd:
        log('服务就绪，端口 %d，共享 %s' % (PORT, ROOT))
        log('下载完成后 %d 秒关机；%d 秒无人下载则兜底关机' % (GRACE, IDLE_MAX))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            log('收到中断，退出（不会关机）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
