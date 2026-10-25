package com.aicompanion.app;

// 调度器：保证「每 N 小时看一次队列」这个任务只有一个实例。
//
// ⚠️ 用 UPDATE 而不是 KEEP：用户改了间隔（设置里 2/4/6/8 小时）要能立刻生效。
//    KEEP 会让第一次装的时候定的间隔永远取消不掉。
// ⚠️ 最小间隔：PeriodicWorkRequest 的下限是 15 分钟，小于它系统会直接抛异常。
//    我们这里最快给 2 小时，离下限很远。

import android.content.Context;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

public class ProactiveScheduler {

    public static final String NAME = "mxj_proactive_tick";

    /** 分钟数 → 兜底成 2 小时；上限 12 小时（再长就不像"想起你"了）。 */
    public static int clampHours(int h) {
        if (h < 2) return 2;
        if (h > 12) return 12;
        return h;
    }

    public static void ensure(Context ctx, int hours) {
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(
                ProactiveWorker.class, clampHours(hours), TimeUnit.HOURS)
                .setConstraints(new Constraints.Builder().build())
                .build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                NAME, ExistingPeriodicWorkPolicy.UPDATE, req);
    }

    public static void stop(Context ctx) {
        WorkManager.getInstance(ctx).cancelUniqueWork(NAME);
    }
}
