const express = require('express');
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');

// .env (BOT_KEY vs)
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 🔒 Sadece bot erişimi için shared secret
const BOT_KEY = process.env.BOT_KEY || 'CHANGE_ME';

// Basit bot-kontrol middleware’i (sadece POST /generate, /generate2, /generate3, /diploma için)
function requireBotKey(req, res, next) {
  // Sadece PDF üreten POST uçlarını koru
  if (
    req.method === 'POST' &&
    (req.path === '/generate' || req.path === '/generate2' || req.path === '/generate3' || req.path === '/diploma')
  ) {
    const key = req.get('X-Bot-Key') || req.get('x-bot-key');
    if (!key || key !== BOT_KEY) {
      // İnsanlar manuel deneyince buraya düşer — HTML + popup ile uyar
      return res
        .status(403)
        .send(`
<!doctype html>
<html><head><meta charset="utf-8"><title>Erişim Kısıtlı</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#0b1220;color:#fff;font-family:system-ui,Segoe UI,Roboto}
  .card{width:min(92vw,560px);background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:28px;backdrop-filter:blur(10px)}
  h1{margin:.2rem 0 1rem;font-weight:700}
  p{opacity:.88;line-height:1.6}
  .btn{margin-top:14px;display:inline-block;padding:10px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.25);text-decoration:none;color:#fff}
</style></head>
<body>
  <div class="card">
    <h1>⛔ Erişim Kısıtlı</h1>
    <p>Bu servis sadece <strong>Telegram botu</strong> üzerinden kullanılabilir.<br/>Lütfen Telegram’dan deneyin.</p>
    <a class="btn" href="https://t.me/CENGIZZATAY" target="_blank" rel="noopener">Telegram’a git</a>
  </div>
<script>alert("Bu site yalnızca Telegram botu tarafından kullanılabilir.");</script>
</body></html>`);
    }
  }
  return next();
}

// 🔧 data klasörü yoksa oluştur (better-sqlite3 için)
const dataDir = path.join(__dirname, 'data');
try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}

const db = new Database(path.join(__dirname, 'data', 'users.db'));

db.prepare(
  "CREATE TABLE IF NOT EXISTS logs (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "ip TEXT," +
  "user TEXT," +
  "tc TEXT," +
  "ad TEXT," +
  "soyad TEXT," +
  "date TEXT)"
).run();

// parse body
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// 🔒 koruma middleware’ini body parsers’tan sonra, route’lardan önce tak
app.use(requireBotKey);

app.use(express.static('public'));
app.use('/fonts', express.static(path.join(__dirname, 'fonts')));
app.use(express.static(path.join(__dirname, 'views')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

/* /kartdurum da aynı sayfayı döner */
app.get('/kartdurum', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

/* /burs route’u da SPA için aynı sayfayı döner */
app.get('/burs', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

/* /diploma route’u da SPA için aynı sayfayı döner */
app.get('/diploma', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-login.html'));
});

app.post('/admin-login', (req, res) => {
  const password = req.body.password;
  if (password === 'FUW9p8oMR9MhkqPnyXka7TGkc') {
    res.redirect('/admin-panel.html');
  } else {
    res.send('<h2>Hatalı şifre dayı!</h2>');
  }
});

/* ----------------------------- ÜCRET PDF (/generate) ----------------------------- */
/* sablon.pdf içinde MİKTAR alanları için güncel mm koordinatları */
const MIKTAR_SAYI_MM = {
  solAlt: { x: 78.6, y: 120.0 },
  solUst: { x: 78.4, y: 116.6 },
  sagAlt: { x: 97.3, y: 119.6 },
  sagUst: { x: 97.0, y: 116.3 },
};
const MIKTAR_YAZI_MM = {
  solAlt: { x: 125.8, y: 119.4 },
  solUst: { x: 125.9, y: 116.6 },
  sagAlt: { x: 154.9, y: 119.2 },
  sagUst: { x: 154.9, y: 117.0 },
};

app.post('/generate', async (req, res) => {
  const { tc, ad, soyad, miktar } = req.body;
  const templatePath = path.join(__dirname, 'public', 'sablon.pdf');

  // TC/Ad/Soyad için eski kalın font
  const boldFontPath = path.join(__dirname, 'fonts', 'LiberationSans-Bold.ttf');
  const boldFontBuf = fs.readFileSync(boldFontPath);

  // Miktar için ince (kalın olmayan) font
  const plainFontPath = path.join(__dirname, 'fonts', 'arial.ttf');
  const plainFontBuf = fs.readFileSync(plainFontPath);

  const existingPdfBytes = fs.readFileSync(templatePath);

  const pdfDoc = await PDFDocument.load(existingPdfBytes);
  pdfDoc.registerFontkit(fontkit);

  const fontBold  = await pdfDoc.embedFont(boldFontBuf);
  const fontPlain = await pdfDoc.embedFont(plainFontBuf);

  const page = pdfDoc.getPages()[0];
  const fontSize = 11;

  // A4 değişse bile sayfa boyutundan mm->pt dönüşümü
  const { width: pageWpt, height: pageHpt } = page.getSize();
  const ptPerMmX = pageWpt / 210; // A4 genişlik 210 mm
  const ptPerMmY = pageHpt / 297; // A4 yükseklik 297 mm
  const mmX = (mm) => mm * ptPerMmX;
  const mmYFromTopToPdfY = (topMm) => pageHpt - topMm * ptPerMmY;

  // ✅ ip sadece BİR KEZ tanımlı
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Eski alanlar (TC / Ad / Soyad)
  const tcPos = { x: 180, y: 588 };
  const adPos = { x: 180, y: 571 };
  const soyadPos = { x: 180, y: 554 };

  page.drawRectangle({ x: 180, y: tcPos.y - 2, width: 180, height: 14, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 180, y: adPos.y - 2, width: 180, height: 14, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 180, y: soyadPos.y - 2, width: 180, height: 14, color: rgb(1, 1, 1) });

  page.drawText(tc || '',    { x: tcPos.x,    y: tcPos.y,    size: fontSize, font: fontBold, color: rgb(0, 0, 0) });
  page.drawText(ad || '',    { x: adPos.x,    y: adPos.y,    size: fontSize, font: fontBold, color: rgb(0, 0, 0) });
  page.drawText(soyad || '', { x: soyadPos.x, y: soyadPos.y, size: fontSize, font: fontBold, color: rgb(0, 0, 0) });

  /* ---------- MİKTAR (rakam ve yazıyla) ---------- */
  if (miktar !== undefined) {
    const miktarInt  = parseMiktarToInt(miktar); // 5.000, 5000, 5,000 hepsi çalışır
    const miktarRakam = new Intl.NumberFormat('tr-TR').format(miktarInt) + ' TL';
    const miktarYazi  = numberToTRWords(miktarInt).replace(/\s+/g, '') + ' TL';

    const PAD_MM = 0.8;               // iç boşluk hesabında kullanılıyor
    const tinyUpPt = 0.5 * ptPerMmY;  // çok az üste (≈0.5 mm)

    function rectFromCornersMM(c) {
      const xs = [c.solAlt.x, c.solUst.x, c.sagAlt.x, c.sagUst.x];
      const ys = [c.solAlt.y, c.solUst.y, c.sagAlt.y, c.sagUst.y];
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const topMm = Math.min(...ys);   // üstten mm
      const botMm = Math.max(...ys);   // alttan mm
      return { xMm: minX, yTopMm: topMm, wMm: maxX - minX, hMm: botMm - topMm };
    }

    function drawIntoBoxMM(boxMM, text, size = 10, leftAlign = true) {
      const box = rectFromCornersMM(boxMM);
      const x = mmX(box.xMm);
      const yTop = mmYFromTopToPdfY(box.yTopMm);
      const w = mmX(box.wMm);
      const h = box.hMm * ptPerMmY;
      const yBottom = yTop - h;

      // arka beyaz dikdörtgen
      page.drawRectangle({
        x, y: yBottom, width: w, height: h, color: rgb(1, 1, 1)
      });

      const pad = mmX(PAD_MM);
      const textWidth  = fontPlain.widthOfTextAtSize(text, size);
      const textHeight = fontPlain.heightAtSize(size);

      let tx = x + pad;
      if (!leftAlign) { // ortala
        tx = x + (w - textWidth) / 2;
      }
      // çok az yukarı kaydır
      const ty = yBottom + (h - textHeight) / 2 + tinyUpPt;

      page.drawText(text, { x: tx, y: ty, size, font: fontPlain, color: rgb(0, 0, 0) });
    }

    // Rakam: sol hücre — 10pt, beyaz kutuya ORTALA
    drawIntoBoxMM(MIKTAR_SAYI_MM, miktarRakam, 10, false);
    // Yazıyla: sağ hücre — 10pt, beyaz kutuya ORTALA
    drawIntoBoxMM(MIKTAR_YAZI_MM, miktarYazi, 10, false);
  }

  const filename = encodeURIComponent((ad || 'DOSYA') + "_" + (soyad || 'PDF') + ".pdf");
  const pdfBytes = await pdfDoc.save();

  db.prepare('INSERT INTO logs (ip, user, tc, ad, soyad, date) VALUES (?, ?, ?, ?, ?, ?)').run(
    ip, "Anonim", tc || '', ad || '', soyad || '', new Date().toISOString()
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(Buffer.from(pdfBytes));
});

/* ------------------------ Yardımcılar (Şablon-2 için) ------------------------ */
const TEMPLATE2_PATH = path.join(__dirname, 'public', 'sablon2.pdf'); // şablon2 burada
const TEMPLATE3_PATH = path.join(__dirname, 'public', 'sablon3.pdf'); // şablon3 burada (BURS)
const TEMPLATE4_PATH = path.join(__dirname, 'public', 'd.pdf');       // DİPLOMA şablonu (d.pdf)

const MM_TO_PT = 2.834645669;
const A4_H_MM = 297;
const PAD_MM_T2 = 0.8;

const mm2pt = (mm) => mm * MM_TO_PT;
const topMmToPdfYpt = (topMm) => mm2pt(A4_H_MM - topMm);
function rectFromCornersMM_T2(c) {
  const xs = [c.solAlt.x, c.solUst.x, c.sagAlt.x, c.sagUst.x];
  const ys = [c.solAlt.y, c.solUst.y, c.sagAlt.y, c.sagUst.y];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const topMm = Math.min(...ys); // üstten ölçü daha küçük
  const botMm = Math.max(...ys);
  return { xMm: minX, yTopMm: topMm, wMm: maxX - minX, hMm: botMm - topMm };
}

/* ----------------------------- KART PDF (/generate2) ----------------------------- */
/* Sabit tarih kutusu koordinatları (mm) — verdiğin değerler */
const FIXED_KOS_MM = {
  solAlt: { x: 92.4, y: 159.1 },
  solUst: { x: 92.1, y: 156.9 },
  sagAlt: { x: 117.7, y: 159.5 },
  sagUst: { x: 117.6, y: 156.2 },
};

app.post('/generate2', async (req, res) => {
  const { adsoyad, adres, ililce, tarih } = req.body;

  // Sabit koordinatları kullan
  const KOS = FIXED_KOS_MM;

  try {
    if (!fs.existsSync(TEMPLATE2_PATH)) {
      return res.status(500).send('sablon2.pdf bulunamadı (public/sablon2.pdf yolunu kontrol et).');
    }

    const existingPdfBytes = fs.readFileSync(TEMPLATE2_PATH);
    const fontPath = path.join(__dirname, 'fonts', 'arial.ttf');
    const customFont = fs.readFileSync(fontPath);

    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    pdfDoc.registerFontkit(fontkit);
    const font = await pdfDoc.embedFont(customFont);

    const page = pdfDoc.getPages()[0];

    /* ---- Ad/Adres/İl-İlçe ---- */
    const fontSizeInfo = 10;
    const adsoyadPos = { x: 345, y: 627 };
    const adresPos   = { x: 345, y: 585 };
    const ililcePos  = { x: 345, y: 560 };

    // Ad Soyad
    page.drawRectangle({ x: adsoyadPos.x - 2, y: adsoyadPos.y - 2, width: 300, height: 14, color: rgb(1, 1, 1) });
    page.drawText((adsoyad || '').trim(), { x: adsoyadPos.x, y: adsoyadPos.y, size: fontSizeInfo, font, color: rgb(0, 0, 0) });

    // Adres + İl/İlçe (kelimeye göre kır)
    const adresFull = [adres, ililce].filter(Boolean).join(', ');
    const lines = wrapByWords(adresFull, 30);
    const lineH = font.heightAtSize(fontSizeInfo) + 2;
    const total = Math.max(1, lines.length);
    const rectY = adresPos.y - 2 - (total - 1) * lineH;
    const rectH = 14 + (total - 1) * lineH;
    page.drawRectangle({ x: adresPos.x - 2, y: rectY, width: 400, height: rectH, color: rgb(1, 1, 1) });
    lines.forEach((line, i) => {
      page.drawText(line, { x: adresPos.x, y: adresPos.y - i * lineH, size: fontSizeInfo, font, color: rgb(0, 0, 0) });
    });

    /* ---- TARİH KUTUSU (sabit) + TARİH METNİ ---- */
    const { xMm, yTopMm, wMm, hMm } = rectFromCornersMM_T2(KOS);
    const xPt = mm2pt(xMm);
    const yTopPt = topMmToPdfYpt(yTopMm);
    const wPt = mm2pt(wMm);
    const hPt = mm2pt(hMm);
    const yBottomPt = yTopPt - hPt;

    // ↓↓↓ ikisini de biraz aşağı indir (pt cinsinden; -3 pt ≈ 1 mm)
    const offsetDown = -3;

    // Beyaz dikdörtgen (aşağı kaydırıldı)
    page.drawRectangle({
      x: xPt,
      y: yBottomPt + offsetDown,
      width: wPt,
      height: hPt,
      color: rgb(1, 1, 1)
    });

    // Tarih metni
    const tarihText = (tarih || '').trim();
    const fontSizeDate = 10;

    const padPt = mm2pt(PAD_MM_T2);
    const xInner = xPt + padPt;
    const yInner = yBottomPt + padPt + offsetDown; // yazı da aşağı kaydırıldı
    const wInner = wPt - 2 * padPt;
    const hInner = hPt - 2 * padPt;

    const textWidth  = font.widthOfTextAtSize(tarihText, fontSizeDate);
    const textHeight = font.heightAtSize(fontSizeDate);

    const textX = xInner + (wInner - textWidth) / 2;
    const textY = yInner + (hInner - textHeight) / 2;

    page.drawText(tarihText, { x: textX, y: textY, size: fontSizeDate, font, color: rgb(0, 0, 0) });

    /* ---- Çıktı: AD_SOYAD_KART.pdf (BÜYÜK) ---- */
    const base = (adsoyad || 'KART').trim().replace(/\s+/g, "_").toUpperCase();
    const filename = encodeURIComponent(base + "_KART.pdf");
    const pdfBytes = await pdfDoc.save();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('generate2 error:', err);
    res.status(500).send('PDF oluşturulamadı.');
  }
});

/* ----------------------------- BURS PDF (/generate3) ----------------------------- */
/* sablon3.pdf + ÜCRET’teki TC/AD/SOYAD ve MİKTAR kutuları ile birebir aynı yerleşim */
app.post('/generate3', async (req, res) => {
  const { tc, ad, soyad, miktar } = req.body;

  try {
    if (!fs.existsSync(TEMPLATE3_PATH)) {
      return res.status(500).send('sablon3.pdf bulunamadı (public/sablon3.pdf yolunu kontrol et).');
    }

    // Fontlar
    const boldFontPath = path.join(__dirname, 'fonts', 'LiberationSans-Bold.ttf'); // TC/Ad/Soyad
    const plainFontPath = path.join(__dirname, 'fonts', 'arial.ttf');             // Miktar kutuları
    const boldFontBuf = fs.readFileSync(boldFontPath);
    const plainFontBuf = fs.readFileSync(plainFontPath);

    const existingPdfBytes = fs.readFileSync(TEMPLATE3_PATH);
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    pdfDoc.registerFontkit(fontkit);

    const fontBold  = await pdfDoc.embedFont(boldFontBuf);
    const fontPlain = await pdfDoc.embedFont(plainFontBuf);

    const page = pdfDoc.getPages()[0];
    const fontSize = 11;

    // Dinamik mm -> pt
    const { width: pageWpt, height: pageHpt } = page.getSize();
    const ptPerMmX = pageWpt / 210;
    const ptPerMmY = pageHpt / 297;
    const mmX = (mm) => mm * ptPerMmX;
    const mmYFromTopToPdfY = (topMm) => pageHpt - topMm * ptPerMmY;

    // TC / Ad / Soyad — ÜCRET ile aynı koordinatlar (pt)
    const tcPos = { x: 180, y: 588 };
    const adPos = { x: 180, y: 571 };
    const soyadPos = { x: 180, y: 554 };

    // Arka beyaz kutular
    page.drawRectangle({ x: 180, y: tcPos.y - 2,  width: 180, height: 14, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: 180, y: adPos.y - 2,  width: 180, height: 14, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: 180, y: soyadPos.y - 2,width: 180, height: 14, color: rgb(1, 1, 1) });

    // Metinleri bas
    page.drawText(tc || '',    { x: tcPos.x,    y: tcPos.y,    size: fontSize, font: fontBold, color: rgb(0, 0, 0) });
    page.drawText(ad || '',    { x: adPos.x,    y: adPos.y,    size: fontSize, font: fontBold, color: rgb(0, 0, 0) });
    page.drawText(soyad || '', { x: soyadPos.x, y: soyadPos.y, size: fontSize, font: fontBold, color: rgb(0, 0, 0) });

    // MİKTAR — ÜCRET’teki mm kutularıyla aynı
    if (miktar !== undefined) {
      const miktarInt  = parseMiktarToInt(miktar);
      const miktarRakam = new Intl.NumberFormat('tr-TR').format(miktarInt) + ' TL';
      const miktarYazi  = numberToTRWords(miktarInt).replace(/\s+/g, '') + ' TL';

      const PAD_MM = 0.8;
      const tinyUpPt = 0.5 * ptPerMmY;

      function rectFromCornersMM(c) {
        const xs = [c.solAlt.x, c.solUst.x, c.sagAlt.x, c.sagUst.x];
        const ys = [c.solAlt.y, c.solUst.y, c.sagAlt.y, c.sagUst.y];
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const topMm = Math.min(...ys);
        const botMm = Math.max(...ys);
        return { xMm: minX, yTopMm: topMm, wMm: maxX - minX, hMm: botMm - topMm };
      }

      function drawIntoBoxMM(boxMM, text, size = 10, leftAlign = true) {
        const box = rectFromCornersMM(boxMM);
        const x = mmX(box.xMm);
        const yTop = mmYFromTopToPdfY(box.yTopMm);
        const w = mmX(box.wMm);
        const h = box.hMm * ptPerMmY;
        const yBottom = yTop - h;

        // beyaz arka plan
        page.drawRectangle({ x, y: yBottom, width: w, height: h, color: rgb(1, 1, 1) });

        const pad = mmX(PAD_MM);
        const textWidth  = fontPlain.widthOfTextAtSize(text, size);
        const textHeight = fontPlain.heightAtSize(size);

        let tx = x + pad;
        if (!leftAlign) tx = x + (w - textWidth) / 2;
        const ty = yBottom + (h - textHeight) / 2 + tinyUpPt;

        page.drawText(text, { x: tx, y: ty, size, font: fontPlain, color: rgb(0, 0, 0) });
      }

      // Rakam ve yazıyla kutulara yaz
      drawIntoBoxMM(MIKTAR_SAYI_MM, miktarRakam, 10, false);
      drawIntoBoxMM(MIKTAR_YAZI_MM, miktarYazi, 10, false);
    }

    // Log ve çıktı
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    db.prepare('INSERT INTO logs (ip, user, tc, ad, soyad, date) VALUES (?, ?, ?, ?, ?, ?)').run(
      ip, "Anonim", tc || '', ad || '', soyad || '', new Date().toISOString()
    );

    const base = ((ad || 'BURS') + "_" + (soyad || 'PDF')).replace(/\s+/g, "_");
    const filename = encodeURIComponent(base.toUpperCase() + "_BURS.pdf");
    const pdfBytes = await pdfDoc.save();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('generate3 error:', err);
    res.status(500).send('PDF oluşturulamadı (BURS).');
  }
});

/* ----------------------------- DİPLOMA PDF (/diploma) ----------------------------- */
/* d.pdf + BURS/ÜCRET ile aynı TC/AD/SOYAD ve MİKTAR yerleşimi */
app.post('/diploma', async (req, res) => {
  const { tc, ad, soyad, miktar } = req.body;

  try {
    if (!fs.existsSync(TEMPLATE4_PATH)) {
      return res.status(500).send('d.pdf bulunamadı (public/d.pdf yolunu kontrol et).');
    }

    // Fontlar (aynı mantık: bold = TC/Ad/Soyad, plain = miktar kutuları)
    const boldFontPath = path.join(__dirname, 'fonts', 'LiberationSans-Bold.ttf');
    const plainFontPath = path.join(__dirname, 'fonts', 'arial.ttf');
    const boldFontBuf = fs.readFileSync(boldFontPath);
    const plainFontBuf = fs.readFileSync(plainFontPath);

    const existingPdfBytes = fs.readFileSync(TEMPLATE4_PATH);
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    pdfDoc.registerFontkit(fontkit);

    const fontBold  = await pdfDoc.embedFont(boldFontBuf);
    const fontPlain = await pdfDoc.embedFont(plainFontBuf);

    const page = pdfDoc.getPages()[0];
    const fontSize = 11;

    // mm -> pt (A4 varsayımı)
    const { width: pageWpt, height: pageHpt } = page.getSize();
    const ptPerMmX = pageWpt / 210;
    const ptPerMmY = pageHpt / 297;
    const mmX = (mm) => mm * ptPerMmX;
    const mmYFromTopToPdfY = (topMm) => pageHpt - topMm * ptPerMmY;

    // TC / Ad / Soyad — ÜCRET/BURS ile aynı koordinatlar
    const tcPos = { x: 180, y: 588 };
    const adPos = { x: 180, y: 571 };
    const soyadPos = { x: 180, y: 554 };

    // Arka beyaz kutular
    page.drawRectangle({ x: 180, y: tcPos.y - 2,  width: 180, height: 14, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: 180, y: adPos.y - 2,  width: 180, height: 14, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: 180, y: soyadPos.y - 2,width: 180, height: 14, color: rgb(1, 1, 1) });

    // Metinleri bas
    page.drawText(tc || '',    { x: tcPos.x,    y: tcPos.y,    size: fontSize, font: fontBold, color: rgb(0, 0, 0) });
    page.drawText(ad || '',    { x: adPos.x,    y: adPos.y,    size: fontSize, font: fontBold, color: rgb(0, 0, 0) });
    page.drawText(soyad || '', { x: soyadPos.x, y: soyadPos.y, size: fontSize, font: fontBold, color: rgb(0, 0, 0) });

    // MİKTAR — ÜCRET/BURS ile aynı mm kutuları
    if (miktar !== undefined) {
      const miktarInt  = parseMiktarToInt(miktar);
      const miktarRakam = new Intl.NumberFormat('tr-TR').format(miktarInt) + ' TL';
      const miktarYazi  = numberToTRWords(miktarInt).replace(/\s+/g, '') + ' TL';

      const PAD_MM = 0.8;
      const tinyUpPt = 0.5 * ptPerMmY;

      function rectFromCornersMM(c) {
        const xs = [c.solAlt.x, c.solUst.x, c.sagAlt.x, c.sagUst.x];
        const ys = [c.solAlt.y, c.solUst.y, c.sagAlt.y, c.sagUst.y];
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const topMm = Math.min(...ys);
        const botMm = Math.max(...ys);
        return { xMm: minX, yTopMm: topMm, wMm: maxX - minX, hMm: botMm - topMm };
      }

      function drawIntoBoxMM(boxMM, text, size = 10, leftAlign = true) {
        const box = rectFromCornersMM(boxMM);
        const x = mmX(box.xMm);
        const yTop = mmYFromTopToPdfY(box.yTopMm);
        const w = mmX(box.wMm);
        const h = box.hMm * ptPerMmY;
        const yBottom = yTop - h;

        // beyaz arka plan
        page.drawRectangle({ x, y: yBottom, width: w, height: h, color: rgb(1, 1, 1) });

        const pad = mmX(PAD_MM);
        const textWidth  = fontPlain.widthOfTextAtSize(text, size);
        const textHeight = fontPlain.heightAtSize(size);

        let tx = x + pad;
        if (!leftAlign) tx = x + (w - textWidth) / 2;
        const ty = yBottom + (h - textHeight) / 2 + tinyUpPt;

        page.drawText(text, { x: tx, y: ty, size, font: fontPlain, color: rgb(0, 0, 0) });
      }

      // Rakam ve yazıyla kutulara yaz
      drawIntoBoxMM(MIKTAR_SAYI_MM, miktarRakam, 10, false);
      drawIntoBoxMM(MIKTAR_YAZI_MM, miktarYazi, 10, false);
    }

    // Log ve çıktı
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    db.prepare('INSERT INTO logs (ip, user, tc, ad, soyad, date) VALUES (?, ?, ?, ?, ?, ?)').run(
      ip, "Anonim", tc || '', ad || '', soyad || '', new Date().toISOString()
    );

    const base = ((ad || 'DIPLOMA') + "_" + (soyad || 'PDF')).replace(/\s+/g, "_");
    const filename = encodeURIComponent(base.toUpperCase() + "_DIPLOMA.pdf");
    const pdfBytes = await pdfDoc.save();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('diploma error:', err);
    res.status(500).send('PDF oluşturulamadı (DIPLOMA).');
  }
});

/* ---- basit kelime-wrapping ---- */
function wrapByWords(str, limit = 30) {
  if (!str) return [''];
  const words = str.trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (w.length > limit) {
      if (line) { lines.push(line); line = ''; }
      for (let i = 0; i < w.length; i += limit) lines.push(w.slice(i, i + limit));
      continue;
    }
    if (!line.length) line = w;
    else if (line.length + 1 + w.length <= limit) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line.length) lines.push(line);
  return lines;
}

/* ---- "5.000" -> 5000 ---- */
function parseMiktarToInt(txt) {
  if (typeof txt !== 'string') return 0;
  const cleaned = txt.replace(/\s/g, '').replace(/\./g, '').replace(/,/g, '.');
  const num = parseFloat(cleaned);
  if (!isFinite(num)) return 0;
  return Math.round(num); // kuruş yok
}

/* ---- 3250 -> "ÜÇ BİN İKİ YÜZ ELLİ" ---- */
function numberToTRWords(n) {
  n = Math.floor(Math.max(0, n));
  if (n === 0) return 'SIFIR';
  const birler = ['', 'BİR', 'İKİ', 'ÜÇ', 'DÖRT', 'BEŞ', 'ALTI', 'YEDİ', 'SEKİZ', 'DOKUZ'];
  const onlar  = ['', 'ON', 'YİRMİ', 'OTUZ', 'KIRK', 'ELLİ', 'ALTMIŞ', 'YETMİŞ', 'SEKSEN', 'DOKSAN'];
  const binlik = ['', 'BİN', 'MİLYON', 'MİLYAR', 'TRİLYON'];

  const three = (x) => {
    const y = x % 1000;
    const yuz = Math.floor(y / 100), on = Math.floor((y % 100) / 10), bir = y % 10;
    const yuzStr = yuz === 0 ? '' : (yuz === 1 ? 'YÜZ' : birler[yuz] + ' YÜZ');
    const onStr  = onlar[on];
    const birStr = birler[bir];
    return [yuzStr, onStr, birStr].filter(Boolean).join(' ');
  };

  let i = 0, words = [];
  while (n > 0 && i < binlik.length) {
    const k = n % 1000;
    if (k) {
      let chunk = three(k);
      if (i === 1 && k === 1) chunk = 'BİN'; // "BİR BİN" değil "BİN"
      words.unshift([chunk, binlik[i]].filter(Boolean).join(' '));
    }
    n = Math.floor(n / 1000);
    i++;
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

app.listen(PORT, () => console.log("http://localhost:" + PORT + " çalışıyor..."));
