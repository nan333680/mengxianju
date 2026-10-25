package com.aicompanion.app;

// ================= LocalEmbed 插件（桥给 JS） =================
//
// 给前端两个方法：
//   embed({ texts: string[] }) → { vectors: number[][], dim, ms }
//   status()                   → { ready, dim, error }
//
// ⚠️ 全部丢到单线程池里跑：ONNX 一次推理 10~80ms，占着主线程会卡住打字与滚动。
// ⚠️ 失败一律 reject 且带原文 —— JS 侧要能看见"为什么不可用"，不能静默变成 0 向量。

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "LocalEmbed")
public class LocalEmbedPlugin extends Plugin {

    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void embed(PluginCall call) {
        JSArray texts = call.getArray("texts");
        if (texts == null) {
            call.reject("缺 texts");
            return;
        }
        // ⚠️ 别用 texts.toList()：它抛受检异常 JSONException，编译都过不去。
        //    optString 不抛，元素不是字符串时原样转成字符串，正好是我们想要的。
        final List<String> list = new ArrayList<>();
        for (int i = 0; i < texts.length(); i++) list.add(texts.optString(i, ""));

        pool.execute(() -> {
            long t0 = System.currentTimeMillis();
            try {
                EmbedEngine eng = EmbedEngine.get(getContext());
                JSArray out = new JSArray();
                for (String t : list) {
                    float[] v = eng.embedOne(t);
                    JSArray row = new JSArray();
                    for (float x : v) row.put((double) x);
                    out.put(row);
                }
                JSObject ret = new JSObject();
                ret.put("vectors", out);
                ret.put("dim", eng.dim());
                ret.put("ms", System.currentTimeMillis() - t0);
                call.resolve(ret);
            } catch (Throwable e) {
                // reject 有两个重载：带 Exception，或不带。Error（比如 OOM）不是 Exception，
                // 传进去编不过 —— 分两路写，别为了省一行留下编不过的代码。
                if (e instanceof Exception) call.reject("embed 失败：" + e.getMessage(), (Exception) e);
                else call.reject("embed 失败：" + e);
            }
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        pool.execute(() -> {
            JSObject ret = new JSObject();
            try {
                EmbedEngine eng = EmbedEngine.get(getContext());
                ret.put("ready", eng.isReady());
                ret.put("dim", eng.dim());
                ret.put("error", eng.lastError());
            } catch (Throwable e) {
                ret.put("ready", false);
                ret.put("dim", 0);
                ret.put("error", String.valueOf(e.getMessage()));
            }
            call.resolve(ret);
        });
    }
}
