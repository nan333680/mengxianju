package com.aicompanion.app;

// ================= 本地向量引擎（辅助层，0.5.3.6 之后） =================
//
// 为什么有这个文件：
//   她的"记忆检索 / 重复检测 / 候选重排"现在靠【关键词重合 + 新近度】（见 persona.js:1313
//   的原注释：不上向量检索，要引依赖还要每轮算 embedding）。关键词重合认不出
//   "你昨天放我鸽子" 和 "你上次也没来" 是同一件事 —— 字面上没有一个字相同。
//
//   这里补的就是那一层：本地跑 bge-small-zh（量化版 24MB），出 512 维向量，余弦相似度。
//
// ⚠️ 三条硬规矩：
//   1. 【只做辅助】主生成仍然走云端。本地模型只负责"像不像""是不是同一件事"。
//   2. 【任何失败都不许挡住聊天】模型加载失败 / 内存不够 / 线程异常 → 抛给 JS，
//      JS 侧捕获后返回 null，上层退回原来的关键词路径。聊天一次都不能因为它失败。
//   3. 【不碰网络】模型和词表都在 APK 自带 assets 里，不下载、不上传。
//
// 体积：模型 24MB + 词表 107KB + onnxruntime 原生库（约 20MB，打包时按 ABI 裁）。

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class EmbedEngine {

    /** 模型与词表都在这两个路径下（android/app/src/main/assets/models/）。 */
    private static final String MODEL_PATH = "models/bge-small-zh-v1.5.onnx";
    private static final String VOCAB_PATH = "models/vocab.txt";

    /** 输入最多 128 个 token。聊天里要比对的是"一句话"，不是整章。 */
    private static final int MAX_TOKENS = 128;

    private static EmbedEngine inst;

    public static synchronized EmbedEngine get(Context ctx) {
        if (inst == null) inst = new EmbedEngine(ctx.getApplicationContext());
        return inst;
    }

    private final Context appCtx;

    private OrtEnvironment env;
    private OrtSession session;
    private Map<String, Integer> vocab;

    private int idCls = 101, idSep = 102, idUnk = 100, idPad = 0;

    /** 模型实际用的输入名（不同导出可能叫 input_ids / input_ids:0 之类，按名字模糊找）。 */
    private String inIds, inMask, inType, outName;

    private int dim = 512;

    private volatile boolean ready = false;
    private volatile String lastErr = "";

    private EmbedEngine(Context c) { appCtx = c; }

    public boolean isReady() { return ready; }
    public String lastError() { return lastErr; }
    public int dim() { return dim; }

    // ---------------- 加载 ----------------

    public synchronized void ensureLoaded() throws Exception {
        if (ready) return;
        long t0 = System.currentTimeMillis();
        AssetManager am = appCtx.getAssets();

        // 1) 词表（BERT WordPiece，一行一个 token，行号就是 id）
        vocab = new HashMap<>(40000);
        try (BufferedReader br = new BufferedReader(new InputStreamReader(am.open(VOCAB_PATH), "UTF-8"))) {
            String line;
            int i = 0;
            while ((line = br.readLine()) != null) {
                vocab.put(line, i);
                i++;
            }
        }
        if (vocab.containsKey("[CLS]")) idCls = vocab.get("[CLS]");
        if (vocab.containsKey("[SEP]")) idSep = vocab.get("[SEP]");
        if (vocab.containsKey("[UNK]")) idUnk = vocab.get("[UNK]");
        if (vocab.containsKey("[PAD]")) idPad = vocab.get("[PAD]");

        // 2) 模型：整块读进内存再交给 ORT。24MB，比反复读 asset 流稳。
        byte[] bytes;
        try (InputStream is = am.open(MODEL_PATH)) {
            bytes = readAll(is);
        }

        // 3) 会话
        env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        // 手机上开多线程反而抢 WebView 的核，单线程足够（128 token 的一句话）。
        opts.setIntraOpNumThreads(2);
        opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        session = env.createSession(bytes, opts);

        // 4) 按名字模糊匹配输入（不同导出前缀不同）
        for (String n : session.getInputNames()) {
            String k = n.toLowerCase();
            if (k.contains("input_ids") || k.equals("ids")) inIds = n;
            else if (k.contains("attention")) inMask = n;
            else if (k.contains("token_type")) inType = n;
        }
        if (session.getOutputNames() != null && !session.getOutputNames().isEmpty()) {
            for (String n : session.getOutputNames()) {
                if (n.toLowerCase().contains("hidden") || n.toLowerCase().contains("embed")) outName = n;
            }
            if (outName == null) outName = session.getOutputNames().iterator().next();
        }
        if (inIds == null) throw new IllegalStateException("模型里找不到 input_ids 输入");

        dim = 512;
        ready = true;
        lastErr = "";
        android.util.Log.i("LocalEmbed", "模型就绪 " + (System.currentTimeMillis() - t0) + "ms, in=" + inIds
                + " mask=" + inMask + " type=" + inType + " out=" + outName);
    }

    private static byte[] readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(26 * 1024 * 1024);
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    // ---------------- 分词（BERT basic + wordpiece，够中文短句用） ----------------

    private List<String> basicTokenize(String s) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            int cl = Character.charCount(cp);
            if (Character.isWhitespace(cp) || Character.isSpaceChar(cp)) {
                flush(out, cur);
            } else if (isCjk(cp)) {
                flush(out, cur);
                out.add(new String(Character.toChars(cp)));
            } else if (isPunct(cp)) {
                flush(out, cur);
                out.add(new String(Character.toChars(cp)));
            } else {
                cur.appendCodePoint(cp);
            }
            i += cl;
        }
        flush(out, cur);
        return out;
    }

    private static void flush(List<String> out, StringBuilder cur) {
        if (cur.length() > 0) { out.add(cur.toString()); cur.setLength(0); }
    }

    private static boolean isCjk(int cp) {
        return (cp >= 0x4E00 && cp <= 0x9FFF)
                || (cp >= 0x3400 && cp <= 0x4DBF)
                || (cp >= 0x3040 && cp <= 0x30FF)
                || (cp >= 0xF900 && cp <= 0xFAFF);
    }

    private static boolean isPunct(int cp) {
        int t = Character.getType(cp);
        return t == Character.CONNECTOR_PUNCTUATION
                || t == Character.DASH_PUNCTUATION
                || t == Character.START_PUNCTUATION
                || t == Character.END_PUNCTUATION
                || t == Character.INITIAL_QUOTE_PUNCTUATION
                || t == Character.FINAL_QUOTE_PUNCTUATION
                || t == Character.OTHER_PUNCTUATION
                || t == Character.MATH_SYMBOL
                || t == Character.CURRENCY_SYMBOL
                || t == Character.MODIFIER_SYMBOL
                || t == Character.OTHER_SYMBOL;
    }

    private List<Integer> wordpiece(String token) {
        token = token.toLowerCase();
        if (token.isEmpty() || token.length() > 100) return null;
        List<Integer> ids = new ArrayList<>();
        int start = 0, n = token.length();
        while (start < n) {
            int end = n;
            Integer hit = null;
            int cut = -1;
            while (end > start) {
                String sub = token.substring(start, end);
                if (start > 0) sub = "##" + sub;
                Integer id = vocab.get(sub);
                if (id != null) { hit = id; cut = end; break; }
                end--;
            }
            if (hit == null) return null;
            ids.add(hit);
            start = cut;
        }
        return ids;
    }

    private List<Integer> encode(String text) {
        List<Integer> ids = new ArrayList<>();
        ids.add(idCls);
        for (String t : basicTokenize(text == null ? "" : text)) {
            List<Integer> wp = wordpiece(t);
            if (wp == null) { ids.add(idUnk); }
            else {
                for (int id : wp) {
                    if (ids.size() >= MAX_TOKENS - 1) break;
                    ids.add(id);
                }
            }
            if (ids.size() >= MAX_TOKENS - 1) break;
        }
        ids.add(idSep);
        return ids;
    }

    // ---------------- 推 理 ----------------

    public synchronized float[] embedOne(String text) throws Exception {
        ensureLoaded();
        List<Integer> ids = encode(text);
        int n = ids.size();
        long[] shape = {1, n};
        long[] a = new long[n], m = new long[n], ty = new long[n];
        for (int i = 0; i < n; i++) { a[i] = ids.get(i); m[i] = 1; ty[i] = 0; }

        OnnxTensor tIds = null, tMask = null, tType = null;
        try {
            tIds = OnnxTensor.createTensor(env, LongBuffer.wrap(a), shape);
            Map<String, OnnxTensor> in = new HashMap<>();
            in.put(inIds, tIds);
            if (inMask != null) {
                tMask = OnnxTensor.createTensor(env, LongBuffer.wrap(m), shape);
                in.put(inMask, tMask);
            }
            if (inType != null) {
                tType = OnnxTensor.createTensor(env, LongBuffer.wrap(ty), shape);
                in.put(inType, tType);
            }
            try (OrtSession.Result res = session.run(in)) {
                Object v = res.get(0).getValue();
                float[] raw = null;
                if (v instanceof float[][][]) {
                    float[][][] x = (float[][][]) v;
                    raw = x[0][0];                       // CLS
                } else if (v instanceof float[][]) {
                    float[][] x = (float[][]) v;
                    raw = x[0];                          // 已经池化过
                } else if (v instanceof float[]) {
                    raw = (float[]) v;
                }
                if (raw == null) throw new IllegalStateException("模型输出形状不认识: " + v.getClass());
                return l2(raw);
            }
        } finally {
            if (tIds != null) tIds.close();
            if (tMask != null) tMask.close();
            if (tType != null) tType.close();
        }
    }

    /** L2 归一化 —— 归一化之后余弦相似度就是点积，JS 侧算得便宜。 */
    private static float[] l2(float[] v) {
        double s = 0;
        for (float x : v) s += (double) x * x;
        double n = Math.sqrt(s);
        if (n < 1e-8) return v;
        float[] out = new float[v.length];
        for (int i = 0; i < v.length; i++) out[i] = (float) (v[i] / n);
        return out;
    }
}
