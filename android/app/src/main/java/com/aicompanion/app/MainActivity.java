package com.aicompanion.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // ⚠️ 必须在 super.onCreate 之前注册，否则 Capacitor 找不到这个插件，
        //    JS 侧 window.Capacitor.Plugins.LocalEmbed 会是 undefined。
        registerPlugin(LocalEmbedPlugin.class);
        registerPlugin(LocalProactivePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
