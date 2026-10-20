"""사용자 칸 3개(사용자1·2·3)를 미리 만들어 두는 관리 도구. 관리자 PC에서 한 번만 실행합니다.

- 서비스 키는 환경변수로만 받습니다(파일·화면·기록에 남기지 않음, 앱 저장소에 넣지 않음).
    PT_SUPABASE_URL           예) https://abcd1234.supabase.co
    PT_SUPABASE_SERVICE_KEY   서비스(service_role) 키
- 몇 번 실행해도 안전합니다(이미 있는 칸은 건드리지 않음).
- 만들어진 계정의 비밀번호는 아무도 모르는 무작위 값이며, 칸이 「미설정」이라 로그인에 쓰이지 않습니다.
  각 사용자가 처음 입력한 비밀번호가 그 칸의 비밀번호로 정해집니다(pt-auth 함수의 setup).
- 사용자3은 「사용 안 함」으로 잠가 둡니다. 쓰실 분이 정해지면 admin/open_slot.sql 로 엽니다.

실행: python seed_users.py --dry-run   (무엇을 할지만 보여 줌)
      python seed_users.py             (실제 실행)
"""
import json
import os
import secrets
import sys
import urllib.error
import urllib.request

SLOTS = [(1, 'unset'), (2, 'unset'), (3, 'disabled')]


def email(slot):
    return f'slot{slot}@pt.example.com'  # supabase/functions/pt-auth/logic.js 의 slotEmail 과 같아야 함


def call(method, url, key, body=None, headers=None):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    h = {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode('utf-8')
            return r.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        text = e.read().decode('utf-8')
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, {'message': text[:200]}


def find_user_id(base, key, mail):
    page = 1
    while True:
        st, d = call('GET', f'{base}/auth/v1/admin/users?page={page}&per_page=100', key)
        if st != 200:
            return None
        users = d.get('users', d) if isinstance(d, dict) else d
        if not users:
            return None
        for u in users:
            if u.get('email') == mail:
                return u['id']
        page += 1


def main():
    dry = '--dry-run' in sys.argv
    base = os.environ.get('PT_SUPABASE_URL', '').rstrip('/')
    key = os.environ.get('PT_SUPABASE_SERVICE_KEY', '')
    if not dry and (not base or not key):
        print('PT_SUPABASE_URL 과 PT_SUPABASE_SERVICE_KEY 환경변수가 필요합니다.')
        return 2
    for slot, state in SLOTS:
        print(f'사용자{slot}: 계정 {email(slot)} 만들기(있으면 건너뜀), 상태 {state}')
        if dry:
            continue
        st, d = call('POST', f'{base}/auth/v1/admin/users', key,
                     {'email': email(slot), 'password': secrets.token_urlsafe(32), 'email_confirm': True})
        if st in (200, 201):
            uid = d['id']
        else:
            uid = find_user_id(base, key, email(slot))
            if not uid:
                print(f'  계정을 만들지 못했습니다 (상태 {st}). 중단합니다.')
                return 1
        st, _ = call('POST', f'{base}/rest/v1/pt_auth_state?on_conflict=slot', key,
                     {'slot': slot, 'user_id': uid, 'state': state},
                     {'Prefer': 'resolution=ignore-duplicates,return=minimal'})
        print('  완료' if st in (200, 201, 204) else f'  상태 표 저장 실패 (상태 {st})')
    print('끝. 앱의 로그인 화면에서 사용자1 → 비밀번호 정하기 순서로 진행하세요.' if not dry else '(시험 실행: 아무것도 바꾸지 않았습니다)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
