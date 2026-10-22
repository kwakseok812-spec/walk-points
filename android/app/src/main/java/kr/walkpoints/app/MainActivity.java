package kr.walkpoints.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

// 폰의 시스템 「글자 크기」(100~200%)가 웹 화면 글자를 따로 키우지 못하게 100%로 고정합니다.
// 앱 안의 「글씨 크기」 6단계(가장 작게~아주 크게)가 유일한 글씨 조절이 됩니다.
// 뒤로 가기 키는 Capacitor 기본 동작(웹 화면의 이전 화면 -> 더 없으면 앱 닫기)을 그대로 따릅니다.
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        lockTextZoom();
    }

    @Override
    public void onResume() {
        super.onResume();
        lockTextZoom(); // 설정에서 글자 크기를 바꾸고 돌아와도 다시 100%로
    }

    private void lockTextZoom() {
        try {
            if (getBridge() == null) return;
            WebView wv = getBridge().getWebView();
            if (wv == null) return;
            WebSettings s = wv.getSettings();
            if (s.getTextZoom() != 100) s.setTextZoom(100);
        } catch (Exception ignored) {
            // 잠그지 못해도 앱은 그대로 동작합니다(이 경우 화면 쪽 보강이 책임집니다).
        }
    }
}
