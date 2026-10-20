"""화면 시험 도우미: 작은 웹 서버를 띄우고 Playwright 로 폰 폭 화면을 엽니다. (크롬 앱 연동 도구는 쓰지 않음)"""
import http.server
import socketserver
import threading
import functools
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PORT = 18431


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.webmanifest': 'application/manifest+json',
                      '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.png': 'image/png'}

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def start_server():
    handler = functools.partial(Handler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


BASE = f'http://127.0.0.1:{PORT}/index.html'

SIZES = {'fold-closed-390': (390, 844), 'fold-open-750': (750, 900)}
