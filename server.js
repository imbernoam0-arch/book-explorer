import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync } from 'fs';

// Load .env
try {
  readFileSync(resolve('.env'), 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });
} catch {}

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_STREAM_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`;
const GEMINI_JSON_URL  = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const bookCache = new Map();
const summaryCache = new Map();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[״"'`׳.,!?:;\-—–()\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilar(found, query) {
  const f = normalize(found);
  const q = normalize(query);
  if (!f || !q) return false;
  if (f === q || f.includes(q) || q.includes(f)) return true;
  const qWords = q.split(' ').filter(w => w.length > 2);
  if (qWords.length === 0) return false;
  const matches = qWords.filter(w => f.includes(w)).length;
  return matches / qWords.length >= 0.6;
}

// ─── Data sources ─────────────────────────────────────────────────────────────

async function fetchGoogleBooks(bookName) {
  try {
    const data = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(bookName)}&maxResults=15&printType=books&orderBy=relevance`
    ).then(r => r.json());
    if (!data.items?.length) return null;
    const candidates = data.items.filter(i => i.volumeInfo?.title && titleSimilar(i.volumeInfo.title, bookName));
    if (!candidates.length) return null;
    const best = candidates.sort((a, b) =>
      (b.volumeInfo.description?.length || 0) - (a.volumeInfo.description?.length || 0)
    )[0];
    const v = best.volumeInfo;
    const cover = (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '')
      .replace('http://', 'https://').replace('zoom=1', 'zoom=2');
    return {
      title: v.title,
      authors: v.authors?.join(', '),
      description: v.description,
      year: v.publishedDate?.slice(0, 4),
      subjects: v.categories?.join(', '),
      cover: cover || null,
      pageCount: v.pageCount,
      ratingsCount: v.ratingsCount || 0,
    };
  } catch { return null; }
}

async function fetchOpenLibrary(bookName) {
  try {
    const data = await fetch(
      `https://openlibrary.org/search.json?title=${encodeURIComponent(bookName)}&limit=5&fields=title,author_name,subject,first_sentence,cover_i,edition_count`
    ).then(r => r.json());
    const docs = (data.docs || []).filter(d => d.title && titleSimilar(d.title, bookName));
    if (!docs.length) return null;
    const doc = docs.sort((a, b) => (b.edition_count || 0) - (a.edition_count || 0))[0];
    return {
      title: doc.title,
      authors: doc.author_name?.join(', '),
      subjects: doc.subject?.slice(0, 8).join(', '),
      firstSentence: doc.first_sentence?.value || (typeof doc.first_sentence === 'string' ? doc.first_sentence : null),
      coverId: doc.cover_i,
      editionCount: doc.edition_count || 0,
    };
  } catch { return null; }
}

async function fetchWikiFull(query, lang) {
  try {
    const hint = lang === 'he' ? ' ספר' : ' book novel';
    for (const srQuery of [query + hint, query]) {
      const searchData = await fetch(
        `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(srQuery)}&format=json&origin=*&srlimit=3`
      ).then(r => r.json());
      const hits = searchData.query?.search || [];
      for (const hit of hits) {
        const title = hit.title;
        const extractData = await fetch(
          `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts&exlimit=1&format=json&origin=*&explaintext=1`
        ).then(r => r.json());
        const pages = extractData.query?.pages;
        const extract = Object.values(pages || {})[0]?.extract?.trim();
        if (extract && extract.length > 300 && !/^may refer to:/i.test(extract)) {
          return { title, extract };
        }
      }
    }
    return null;
  } catch { return null; }
}

async function fetchDDGSnippets(query) {
  try {
    const html = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': UA }
    }).then(r => r.text());
    const snippets = [];
    for (const m of html.matchAll(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi)) {
      const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text.length > 60) snippets.push(text);
      if (snippets.length >= 5) break;
    }
    return snippets.join('\n') || null;
  } catch { return null; }
}

async function getBookData(bookName) {
  if (bookCache.has(bookName)) return bookCache.get(bookName);
  const [google, openLib, heWiki, enWiki, ddg] = await Promise.all([
    fetchGoogleBooks(bookName),
    fetchOpenLibrary(bookName),
    fetchWikiFull(bookName, 'he'),
    fetchWikiFull(bookName, 'en'),
    fetchDDGSnippets(`${bookName} book themes summary review`),
  ]);
  const data = { google, openLib, heWiki, enWiki, ddg };
  bookCache.set(bookName, data);
  return data;
}

function bookVerified({ google, openLib, heWiki, enWiki }) {
  const hasGoogleSolid = !!(google && google.description && google.description.length > 80);
  const hasGoogleWeak = !!(google && google.authors);
  const hasHeWiki = !!(heWiki && heWiki.extract && heWiki.extract.length > 400);
  const hasEnWiki = !!(enWiki && enWiki.extract && enWiki.extract.length > 400);
  const hasOL = !!(openLib && openLib.editionCount >= 3 && (openLib.authors || openLib.subjects));
  const strong = (hasGoogleSolid ? 1 : 0) + (hasHeWiki ? 1 : 0) + (hasEnWiki ? 1 : 0) + (hasOL ? 1 : 0);
  const weak = (hasGoogleWeak ? 1 : 0);
  return strong >= 1 || weak >= 2;
}

function buildRawContext({ google, openLib, heWiki, enWiki, ddg }) {
  const parts = [];
  if (google?.title) parts.push(`כותרת רשמית (Google Books): ${google.title}${google.authors ? ` — ${google.authors}` : ''}${google.year ? ` (${google.year})` : ''}`);
  if (google?.description) parts.push(`תיאור (Google Books):\n${google.description.slice(0, 1500)}`);
  if (openLib?.firstSentence) parts.push(`פתיחת הספר:\n${openLib.firstSentence}`);
  if (openLib?.authors && !google?.authors) parts.push(`מחברים (Open Library): ${openLib.authors}`);
  if (heWiki?.extract) parts.push(`ויקיפדיה עברית — "${heWiki.title}":\n${heWiki.extract.slice(0, 2000)}`);
  if (enWiki?.extract) parts.push(`Wikipedia (English) — "${enWiki.title}":\n${enWiki.extract.slice(0, 2000)}`);
  if (ddg) parts.push(`מהאינטרנט:\n${ddg}`);
  return parts.join('\n\n---\n\n');
}

// ─── Gemini streaming ─────────────────────────────────────────────────────────

function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}
function sendSSE(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

async function streamGemini(res, systemPrompt, userMessage) {
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: { temperature: 0.75, maxOutputTokens: 2500 },
  };

  const geminiRes = await fetch(GEMINI_STREAM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!geminiRes.ok) {
    const err = await geminiRes.text();
    sendSSE(res, { error: `Gemini error: ${err}` });
    return;
  }

  const reader = geminiRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try {
        const json = JSON.parse(raw);
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) sendSSE(res, { text });
      } catch {}
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/summary', async (req, res) => {
  const { book } = req.body;
  if (!book) return res.status(400).json({ error: 'חסר שם ספר' });

  const cacheKey = book.trim().toLowerCase();
  if (summaryCache.has(cacheKey)) return res.json(summaryCache.get(cacheKey));

  try {
    const data = await getBookData(book);
    const { google, openLib, heWiki, enWiki } = data;

    if (!bookVerified(data)) {
      return res.status(404).json({
        error: 'לא מצאתי את הספר הזה במקורות אמינים. נסה לכתוב את השם בדיוק כפי שמופיע על הכריכה, או להוסיף את שם הסופר (לדוגמה: "1984 אורוול").'
      });
    }

    let cover = google?.cover;
    if (!cover && openLib?.coverId) cover = `https://covers.openlibrary.org/b/id/${openLib.coverId}-L.jpg`;

    const rawContext = buildRawContext(data);
    const identifiedTitle = google?.title || heWiki?.title || enWiki?.title || openLib?.title || book;
    const identifiedAuthors = google?.authors || openLib?.authors || '';

    const prompt = `לפני הכל — בדיקת אמת:

המשתמש מחפש סיכום עבור הספר ששמו: "${book}"
המידע שאספנו ממקורות אמינים על הספר נמצא בסוף הפרומפט.

חוקי ברזל:
1. אם המידע למטה לא מתאר ספר מוכר וברור, או שהוא מערב מספר ספרים שונים, או שאתה לא יכול לזהות בוודאות את הספר — החזר בדיוק את זה ושום דבר אחר:
   { "notFound": true, "reason": "תיאור קצר בעברית למה לא הצלחת לזהות" }
2. אסור להמציא דמויות, ציטוטים, רעיונות, נושאים או תיאורים שלא מבוססים על המידע למטה או על ידע אמיתי שלך על הספר.
3. עדיף להחזיר notFound מאשר להמציא תוכן.
4. אם המידע מצביע על ספר אחר מזה שהמשתמש ביקש — החזר notFound.

רק אם אתה בטוח שזה ספר אמיתי שאתה מכיר היטב (גם דרך הידע שלך וגם דרך המידע למטה), המשך לכתוב את הסיכום במבנה למטה.

---

אתה לא מסכם את הספר "${book}". אתה מוביל את הקורא דרך מסע תודעתי דרכו.

המטרה: שהמשתמש ירגיש שהוא עבר דרך מערכת חשיבה חדשה — לא שקיבל תקציר.
הטון: חכם, אנושי, חד, לא מתאמץ להרשים, עמוק בלי להיות מתנשא.

החזר JSON תקין בלבד (ללא \`\`\`json וללא טקסט נוסף), בעברית, בדיוק במבנה הבא:

{
  "openingLine": "משפט אחד שחושף את הלב של הספר. לא 'הספר עוסק ב'. לדוגמה: 'זה לא ספר על כסף — זה ספר על הפחד להרגיש חסר ערך.'",
  "whatItChanges": ["3-5 נקודות חדות — מה הספר באמת מנסה לשנות (צורת חשיבה, תפיסת מציאות, יחס לזמן/פחד/הצלחה/אהבה/שליטה)"],
  "ideaMap": {
    "central": "הרעיון המרכזי, מילה או שתיים",
    "branches": [
      { "name": "רעיון משנה", "tension": "פרדוקס או התנגשות פנימית, או null אם אין" }
    ]
  },
  "stage1_problem": {
    "title": "משפט חד שתופס את הבעיה שהספר מזהה",
    "whatPeopleMiss": "פסקה (3-5 משפטים) - מה הספר רואה שאחרים מפספסים",
    "centralIllusion": "האשליה המרכזית - מה לדעת הספר העולם מאמין בו בטעות",
    "whyItMatters": "למה זה חשוב ברמה אנושית, לא אינטלקטואלית"
  },
  "stage2_breaking": {
    "title": "כותרת לפירוק החשיבה הישנה",
    "beliefsAttacked": [
      { "belief": "אמונה שהספר תוקף", "whyExists": "למה היא קיימת בעולם", "whyLimiting": "למה הספר חושב שהיא מגבילה" }
    ],
    "whatCracks": [
      { "domain": "זהות / הרגלים / תפיסת הצלחה / תפיסת אהבה / תפיסת זמן / תפיסת עצמי", "shift": "איך זה מתחיל להשתנות" }
    ]
  },
  "stage3_bigIdea": {
    "title": "כותרת לרעיון הגדול",
    "coreIdea": "הרעיון המרכזי - פשוט, חד, עמוק. משפט אחד או שניים.",
    "whyItChangesEverything": "פסקה - למה הרעיון הזה משנה צורת הסתכלות על החיים",
    "examples": [
      { "type": "אנלוגיה / דוגמה מהחיים / הקשר לעולם", "text": "תיאור הדוגמה" }
    ]
  },
  "stage4_reality": {
    "title": "כותרת להתנגשות עם המציאות",
    "whereHard": [
      { "obstacle": "התנגדות / פחד / מנגנון הגנה / פרדוקס", "description": "תיאור קצר" }
    ],
    "unspoken": "מה הספר לא אומר ישירות - הנחה סמויה או פחד מתחת לרעיונות",
    "patterns": ["דפוס שחוזר בספר או רעיון שכמעט מתוודה"]
  },
  "stage5_shift": {
    "title": "כותרת לשינוי התודעה",
    "shifts": [
      { "domain": "זמן / אנשים / פחד / הצלחה / עצמי", "change": "איך אתה רואה את זה אחרת אחרי הספר" }
    ],
    "beforeAfter": [
      { "before": "מצב/דפוס לפני", "after": "מצב/דפוס אחרי" }
    ]
  },
  "hiddenMechanism": {
    "whatDrives": "מה באמת מניע את הספר - משפט אחד חד",
    "fearBeneath": "איזה פחד נמצא מתחת לרעיונות",
    "humanNeed": "איזה צורך אנושי הספר מנסה לפתור",
    "unspokenSentence": "המשפט שהספר מנסה להגיד בלי להגיד - חד וחושפני"
  },
  "closing": "משפט שקט אחד או שניים שסוגרים את החוויה - לא סיכום, רק תחושה"
}

כללים:
- JSON תקין בלבד. בעברית.
- whatItChanges: 3-5 פריטים. branches: 4-6. beliefsAttacked: 3-4. whatCracks: 3-5. examples: 2-3. whereHard: 3-4. patterns: 2-4. shifts: 4-5. beforeAfter: 4-5.
- אל תהיה כללי - תהיה ספציפי לספר הזה.
- אל תכתוב "הספר אומר ש..." או "המחבר טוען ש..." - דבר ישירות מתוך הרעיונות.
- כל משפט צריך להרגיש שהוא מגלה משהו, לא שהוא מסביר.
- אסור להמציא. אם אתה לא בטוח לגבי פרט מסוים - השמט אותו במקום לנחש.

הספר שזוהה במקורות: "${identifiedTitle}"${identifiedAuthors ? ` מאת ${identifiedAuthors}` : ''}
${rawContext ? `\nמידע אמיתי על הספר ממקורות חיצוניים (השתמש בו כדי לעגן את הסיכום באמת, אל תצטט מילולית):\n${rawContext.slice(0, 4000)}` : ''}`;

    const geminiRes = await fetch(GEMINI_JSON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: 'אתה מומחה ספרות. ענה תמיד ב-JSON תקין בלבד, בעברית.' }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.55, maxOutputTokens: 8000, responseMimeType: 'application/json' },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      let userMsg = 'שגיאה בשירות הבינה המלאכותית';
      if (geminiRes.status === 429) userMsg = 'חרגנו ממגבלת הבקשות ל-AI. נסה שוב מחר או פנה למפתח.';
      return res.status(500).json({ error: userMsg, detail: errText });
    }

    const geminiData = await geminiRes.json();
    const jsonText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!jsonText) {
      const reason = geminiData.candidates?.[0]?.finishReason || 'UNKNOWN';
      return res.status(500).json({ error: `תגובת AI ריקה (${reason}). נסה שוב.` });
    }

    let structured;
    try { structured = JSON.parse(jsonText); }
    catch { return res.status(500).json({ error: 'שגיאה בעיבוד תגובת ה-AI. נסה שוב.' }); }

    if (structured.notFound) {
      return res.status(404).json({
        error: `לא הצלחתי לזהות את הספר "${book}" בוודאות${structured.reason ? ` (${structured.reason})` : ''}. נסה שם מדויק יותר או הוסף את שם הסופר.`
      });
    }

    if (!structured.openingLine && !structured.stage1_problem && !structured.stage3_bigIdea) {
      return res.status(500).json({ error: 'תגובת AI לא תקינה. נסה שוב.' });
    }

    const result = {
      title: google?.title || heWiki?.title || enWiki?.title || book,
      authors: google?.authors || openLib?.authors || null,
      year: google?.year || null,
      pageCount: google?.pageCount || null,
      subjects: (google?.subjects || openLib?.subjects || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 6),
      cover: cover || null,
      ...structured,
    };
    summaryCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { book, question, summaryContext } = req.body;
  if (!book || !question) return res.status(400).json({ error: 'חסרים פרטים' });
  setupSSE(res);

  try {
    const system = `אתה עוזר ספרותי מומחה בספר "${book}". ענה תמיד בעברית, בצורה ממוקדת וחכמה.${summaryContext ? `\n\nהנה סיכום הספר שנוצר:\n${summaryContext}` : ''}`;

    await streamGemini(res, system, question);
    sendSSE(res, { done: true });
    res.end();
  } catch (err) {
    sendSSE(res, { error: err.message });
    res.end();
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Book Explorer → http://localhost:${PORT}`));
