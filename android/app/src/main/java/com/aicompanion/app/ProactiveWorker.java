package com.aicompanion.app;

// ================= 主动消息通知（0.5.3.6，实施规格 §6 方案 C） =================
//
// 为什么是「预写好 + 本地通知」而不是后台直接跑模型：
//   WebView 一进后台就被系统冻结，JS 根本不会再跑 —— 后台唤醒必须是【原生】发起的。
//   而在原生里带着 API key 去请求云端，等于把用户的密钥从 WebView 挪到 Java 层再存一份，
//   为了一个通知不值当。所以：App 开着的时候先把几句话写好、交给原生存着，
//   到点了原生只负责挑一条、弹通知。点开 App 再补成正式消息。
//
// ⚠️ 三条硬规矩：
//   1. 通知里【不出现】「AI 伴侣」「梦弦居」这类字眼 —— 锁屏上被人看见会很尴尬。
//      只显示角色名 + 那一句话本身。
//   2. 任何一步失败都 return success()。WorkManager 的失败重试没有意义，
//      而且会形成"失败→重跑→再失败"的耗电循环。
//   3. 一次只取一条，取完立刻从队列里删掉并存进 pending ——
//      同一个队列被弹第二次是 bug，不是功能。

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

public class ProactiveWorker extends Worker {

    /** 通知渠道 id。改动它等于换一个新渠道（用户已经关掉的旧渠道不会被带回来）。 */
    public static final String CHANNEL = "mxj_proactive";

    /** 预写队列所在的 SharedPreferences 文件名。JS 侧通过 LocalProactive 插件读写同一个文件。 */
    public static final String PREF = "mxj_proactive";

    public ProactiveWorker(@NonNull Context ctx, @NonNull WorkerParameters p) {
        super(ctx, p);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            Context c = getApplicationContext();
            SharedPreferences sp = c.getSharedPreferences(PREF, Context.MODE_PRIVATE);
            // 上一条还没被用户点开（pending 还在）就不再弹新的：
            // 人是会连着发好几条，但通知栏堆一排"她想起你了"更像推送机器人。
            // 等他把上一条看掉，下一次 tick 再弹。
            if (!sp.getString("pending", "").isEmpty()) return Result.success();
            JSONArray arr = new JSONArray(sp.getString("queue", "[]"));
            if (arr.length() == 0) return Result.success();

            JSONObject it = arr.getJSONObject(0);
            String text = it.optString("text", "");
            String name = it.optString("charName", "");
            String charId = it.optString("charId", "");
            if (text.isEmpty()) return Result.success();

            // 先把这条挪走再弹通知：弹之前就失败的话，宁可这条丢了
            // （丢一条只会少一句开场白），也不能出现"同一条弹一整天"。
            JSONArray rest = new JSONArray();
            for (int i = 1; i < arr.length(); i++) rest.put(arr.get(i));
            JSONObject pending = new JSONObject();
            pending.put("text", text);
            pending.put("charName", name);
            pending.put("charId", charId);
            pending.put("at", System.currentTimeMillis());
            sp.edit().putString("queue", rest.toString()).putString("pending", pending.toString()).apply();

            show(c, name, text);
        } catch (Throwable t) {
            // 静默：通知失败绝不能反过来变成"任务失败、系统重试、耗电"
        }
        return Result.success();
    }

    private void show(Context c, String name, String text) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "消息", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("她想起你的时候发的一句话");
            ch.setShowBadge(true);
            nm.createNotificationChannel(ch);
        }

        Intent open = new Intent(c, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("fromProactive", true);
        PendingIntent pi = PendingIntent.getActivity(
                c, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String title = name == null || name.isEmpty() ? "新消息" : name;
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            b.setCategory(Notification.CATEGORY_MESSAGE);
        }
        try { nm.notify(0x4D58, b.build()); } catch (Throwable t) { /* 权限没给 / 渠道被关，就没了 */ }
    }
}
