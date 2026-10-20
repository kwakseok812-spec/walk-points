import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from ui_lib import *
from playwright.sync_api import sync_playwright

srv = start_server()
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, locale='ko-KR')
    pg = ctx.new_page()
    msgs = []
    pg.on('console', lambda m: msgs.append((m.type, m.text)))
    pg.on('pageerror', lambda e: msgs.append(('pageerror', str(e))))
    pg.goto(BASE + '?mock=1')
    pg.wait_for_timeout(800)
    pg.screenshot(path=os.path.join(ROOT, 'shots', '_smoke_login.png'))
    print(msgs)
    b.close()
srv.shutdown()
