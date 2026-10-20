// config.js - 서버 연결 값 자리표시자.
// 새 Supabase 프로젝트를 만든 뒤 아래 두 값만 채웁니다. (비밀 키가 아니라 「공개용 키」만 넣습니다)
//   SUPABASE_URL      : 프로젝트 주소  예) https://abcd1234.supabase.co
//   SUPABASE_ANON_KEY : 공개용(anon / publishable) 키
// 서비스 키(service_role)는 절대 여기에 넣지 않습니다. (공개 저장소에 올라갑니다)
export const SUPABASE_URL = 'https://nlcwecoqgwcqazcjybdw.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_8hkKv4Y-mcBIOAS5pBBfjw_tHXGHCrI';

// 화면 파일을 바꿔 올릴 때마다 올립니다. (서비스워커 캐시 이름과 맞춰야 폰이 새 화면을 받습니다)
export const APP_BUILD = 6;
export const APP_VERSION = '1.0.0';

export const isConfigured = () => !/YOUR-/.test(SUPABASE_URL) && !/YOUR-/.test(SUPABASE_ANON_KEY);
