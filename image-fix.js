/* =========================
   ボドゲスコア 画像軽量化アドオン
   - 新しくアップロードする画像を自動で縮小（最大256px・WebP/JPEG）
   - キャッシュ期間を1年に設定（2回目以降はSupabaseに取りに来ない）
   - 「データ管理」画面に、既存画像を一括で軽量化するボタンを追加
   ※ index.html のメインの<script>より後で読み込むこと
========================= */

(function () {

  let started = false;

  function start() {

  if (started) return;

  if (typeof supabaseClient === "undefined") {
    console.error("image-fix.js: supabaseClient が見つかりません。読み込み順を確認してください。");
    return;
  }

  started = true;

  const BUCKET = "game-images";
  const MAX_SIZE = 256;
  const CACHE_SECONDS = "31536000"; // 1年
  const OPTIMIZED_PREFIX = "t256_";
  const ALREADY_SMALL_BYTES = 60 * 1024;
  const PUBLIC_MARKER =
    "/storage/v1/object/public/" + BUCKET + "/";

  /* ---------- 画像の縮小 ---------- */

  async function loadImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(resolve =>
      canvas.toBlob(resolve, type, quality)
    );
  }

  async function compressImage(blob) {

    const img = await loadImage(blob);

    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;

    const scale =
      Math.min(1, MAX_SIZE / Math.max(w0, h0));

    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);

    // WebP（対応ブラウザのみ）
    const webp = await canvasToBlob(canvas, "image/webp", 0.8);
    if (webp && webp.type === "image/webp") {
      return webp;
    }

    // 非対応ならJPEG（透明部分は白で埋める）
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    return await canvasToBlob(canvas, "image/jpeg", 0.82);

  }

  function extFromType(type) {
    if (type === "image/webp") return "webp";
    if (type === "image/png") return "png";
    return "jpg";
  }

  /* ---------- アップロード時に自動で縮小＋長期キャッシュ ---------- */

  /*
   * supabaseClient.storage は参照するたびに新しく作られるため、
   * 個々のインスタンスではなく共通の設計図（prototype）を書き換える
   */
  const storageProto =
    Object.getPrototypeOf(supabaseClient.storage);

  const originalFrom = storageProto.from;

  storageProto.from = function (bucketId) {

    const bucketApi = originalFrom.call(this, bucketId);

    if (bucketId !== BUCKET) return bucketApi;

    const originalUpload =
      bucketApi.upload.bind(bucketApi);

    bucketApi.upload = async function (path, file, options) {

      const opts = Object.assign({}, options || {});
      const skipCompress = opts.skipCompress;
      delete opts.skipCompress;

      let body = file;

      if (!skipCompress && file instanceof Blob) {
        try {
          const small = await compressImage(file);
          if (small && small.size < file.size) {
            body = small;
            opts.contentType = small.type;
          }
        } catch (error) {
          console.warn("画像の縮小に失敗したため、元の画像をアップロードします:", error);
        }
      }

      opts.cacheControl = CACHE_SECONDS;

      return originalUpload(path, body, opts);

    };

    return bucketApi;

  };

  /* ---------- 既存画像の一括軽量化 ---------- */

  function pathFromUrl(url) {
    const index = url.indexOf(PUBLIC_MARKER);
    if (index === -1) return null;
    return decodeURIComponent(
      url.substring(index + PUBLIC_MARKER.length).split("?")[0]
    );
  }

  async function optimizeExistingImages(button) {

    const targets =
      data.games.filter(game => {
        if (!game.image) return false;
        const path = pathFromUrl(game.image);
        return path && !path.startsWith(OPTIMIZED_PREFIX);
      });

    if (targets.length === 0) {
      alert("軽量化が必要な画像はありません。");
      return;
    }

    if (
      !confirm(
        `${targets.length}件のゲーム画像を小さく作り直します。\n\n` +
        "数分かかる場合があります。終わるまでこの画面を閉じないでください。\n\n実行しますか？"
      )
    ) {
      return;
    }

    const originalLabel = button.textContent;
    button.disabled = true;

    let converted = 0;
    let skipped = 0;
    const failed = [];

    for (let i = 0; i < targets.length; i++) {

      const game = targets[i];

      button.textContent =
        `軽量化中… ${i + 1} / ${targets.length}`;

      try {

        const oldPath = pathFromUrl(game.image);

        const { data: original, error: downloadError } =
          await supabaseClient.storage.from(BUCKET).download(oldPath);

        if (downloadError) throw downloadError;

        // すでに十分小さい画像はそのまま
        if (original.size <= ALREADY_SMALL_BYTES) {
          skipped++;
          continue;
        }

        const small = await compressImage(original);

        const body =
          small && small.size < original.size ? small : original;

        const newPath =
          `${OPTIMIZED_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2)}.${extFromType(body.type)}`;

        const { error: uploadError } =
          await supabaseClient.storage.from(BUCKET).upload(
            newPath,
            body,
            {
              upsert: false,
              contentType: body.type || "image/jpeg",
              skipCompress: true
            }
          );

        if (uploadError) throw uploadError;

        const { data: urlData } =
          supabaseClient.storage.from(BUCKET).getPublicUrl(newPath);

        const { error: updateError } =
          await supabaseClient
            .from("games")
            .update({ image_url: urlData.publicUrl })
            .eq("id", game.id);

        if (updateError) {
          await supabaseClient.storage.from(BUCKET).remove([newPath]);
          throw updateError;
        }

        const { error: removeError } =
          await supabaseClient.storage.from(BUCKET).remove([oldPath]);

        if (removeError) {
          console.warn("古い画像の削除に失敗:", removeError);
        }

        converted++;

      } catch (error) {

        console.error("画像の軽量化に失敗:", game.name, error);
        failed.push(game.name);

      }

    }

    await initializeSupabaseData();

    button.disabled = false;
    button.textContent = originalLabel;

    alert(
      `完了しました。\n\n軽量化：${converted}件\n元から小さい：${skipped}件` +
      (failed.length > 0
        ? `\n失敗：${failed.length}件\n（${failed.join("、")}）`
        : "")
    );

  }

  /* ---------- データ管理画面にボタンを追加 ---------- */

  function addOptimizeButton() {

    const card =
      document.querySelector("#backupScreen .card");

    if (!card || document.getElementById("optimizeImagesButton")) return;

    const area = document.createElement("div");
    area.style.marginTop = "24px";

    const note = document.createElement("p");
    note.className = "section-note";
    note.style.margin = "0 0 8px";
    note.textContent =
      "登録済みのゲーム画像を小さく作り直して、通信量を減らします（最初に1回実行すればOK）。";

    const button = document.createElement("button");
    button.type = "button";
    button.id = "optimizeImagesButton";
    button.className = "secondary";
    button.textContent = "🖼️ ゲーム画像を軽量化";
    button.onclick = () => optimizeExistingImages(button);

    area.appendChild(note);
    area.appendChild(button);
    card.appendChild(area);

  }

  addOptimizeButton();

  console.log("image-fix.js: 読み込み完了");

  }

  /*
   * 読み込み位置がどこでも動くよう、
   * ページの読み込み完了後にも実行を試みる
   */
  start();

  if (!started) {
    window.addEventListener("load", start);
  }

})();
