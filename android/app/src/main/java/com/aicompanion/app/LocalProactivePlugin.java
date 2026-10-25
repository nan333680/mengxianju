package com.aicompanion.app;

// ================= LocalProactive 插件 =================
//
// 这个插件只做「交接」：JS 把预写好的句子交给原生，原生到点弹通知；
// 用户点开 App 后，JS 再来把那条取走、补成正式消息。
//
// JS 侧封装在 www/js/nativeproactive.js，取不到插件就整个功能静默关闭
// （浏览器 / e2e / 老版本壳都是这个路径）。

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "LocalProactive")
public class LocalProactivePlugin extends Plugin {

    private static final int REQ_NOTIF = 0x4D59;
    private static final String TAG = "LocalProactive";

    private SharedPreferences sp() {
        return getContext().getSharedPreferences(ProactiveWorker.PREF, Context.MODE_PRIVATE);
    }

    /** JS 把预写队列整批推过来（每次覆盖，不做增量 —— 队列只有几条，增量只会带来不一致）。 */
    @PluginMethod
    public void setQueue(PluginCall call) {
        JSArray items = call.getArray("items");
        String raw = items == null ? "[]" : items.toString();
        sp().edit().putString("queue", raw).apply();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("count", items == null ? 0 : items.length());
        call.resolve(ret);
    }

    /** 取走「已经弹过通知但还没在聊天里出现」的那一条。取走即清空，重复调用只会拿到一次。 */
    @PluginMethod
    public void takePending(PluginCall call) {
        SharedPreferences p = sp();
        String raw = p.getString("pending", "");
        JSObject ret = new JSObject();
        if (raw == null || raw.isEmpty()) {
            ret.put("item", JSObject.NULL);
            call.resolve(ret);
            return;
        }
        try {
            // 手写四个字段而不是 new JSObject(JSONObject)：
            // Capacitor 8 的 JSObject 没有接收 JSONObject 的构造器（编译报"JSONObject 无法转换为 String"），
            // 而且这几个字段是固定的，逐个别写反而更清楚。
            org.json.JSONObject o = new org.json.JSONObject(raw);
            JSObject item = new JSObject();
            item.put("text", o.optString("text", ""));
            item.put("charId", o.optString("charId", ""));
            item.put("charName", o.optString("charName", ""));
            item.put("at", o.optLong("at", 0L));
            ret.put("item", item);
        } catch (Throwable t) {
            ret.put("item", JSObject.NULL);
        }
        p.edit().remove("pending").apply();
        call.resolve(ret);
    }

    /** 队列 / 待展示 / 权限 / 间隔，一次看全（设置页与诊断用）。 */
    @PluginMethod
    public void status(PluginCall call) {
        SharedPreferences p = sp();
        int n = 0;
        try { n = new JSArray(p.getString("queue", "[]")).length(); } catch (Throwable ignored) {}
        JSObject ret = new JSObject();
        ret.put("queue", n);
        ret.put("hasPending", !p.getString("pending", "").isEmpty());
        ret.put("hours", p.getInt("hours", 6));
        ret.put("perm", hasPerm());
        ret.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    /** 设定间隔并（重新）调度。即使队列现在是空的也照排：预写是随时会补的。 */
    @PluginMethod
    public void schedule(PluginCall call) {
        Integer h = call.getInt("hours", 6);
        int hours = ProactiveScheduler.clampHours(h == null ? 6 : h);
        sp().edit().putInt("hours", hours).apply();
        try {
            ProactiveScheduler.ensure(getContext(), hours);
        } catch (Throwable t) {
            call.reject("调度失败：" + t.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("hours", hours);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try { ProactiveScheduler.stop(getContext()); } catch (Throwable ignored) {}
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /** 清空队列与待展示（换角色 / 关掉功能时用，避免旧角色的句子冒出来）。 */
    @PluginMethod
    public void clear(PluginCall call) {
        sp().edit().remove("queue").remove("pending").apply();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /** 申请通知权限（Android 13+ 必须运行时申请，否则通知静默不弹）。 */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        JSObject ret = new JSObject();
        if (hasPerm()) { ret.put("granted", true); call.resolve(ret); return; }
        Activity act = getActivity();
        if (act == null) { ret.put("granted", false); call.resolve(ret); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // 弹权限框必须在主线程：插件方法跑在 Capacitor 的 bridge 线程上，
            // 在后台线程直接调 requestPermissions 有些 ROM 会抛异常（而且用户永远看不到框）。
            // 这里丢到 UI 线程去弹，resolve 只回报"现在有没有权限" —— 用户点完以后
            // 下一次 status() 才是准的，JS 那边本来也只在下一次预写时才会再查。
            final Activity a = act;
            a.runOnUiThread(() -> {
                try {
                    ActivityCompat.requestPermissions(a,
                            new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIF);
                } catch (Throwable t) {
                    Log.w(TAG, "弹通知权限框没成：" + t);
                }
            });
        }
        ret.put("granted", hasPerm());
        ret.put("asked", true);
        call.resolve(ret);
    }

    private boolean hasPerm() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }
}
