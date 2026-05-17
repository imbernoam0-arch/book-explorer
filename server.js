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

const AGGREGATOR_PATTERNS = [
  'summaries', 'summary of', 'study guide', 'flashbooks', 'sparknotes', 'instaread',
  'getabstract', 'shortform', 'bookrags', 'cliffsnotes', 'litcharts', 'blinkist',
  'analysis of', 'companion to', 'guide to'
];

function isAggregator(item) {
  const t = normalize(item.title || '');
  const a = normalize((item.authors || []).join(' '));
  return AGGREGATOR_PATTERNS.some(p => t.includes(p) || a.includes(p));
}

function cleanTitle(t) {
  if (!t) return t;
  return String(t)
    .replace(/\s*\((ספר|book|novel|רומן|הרומן|הספר)\)\s*$/i, '')
    .replace(/\s*:\s*$/, '')
    .trim();
}

function primaryAuthor(authors) {
  if (!authors) return authors;
  // Take only the first author — translators and editors are usually listed after the main author
  const first = String(authors).split(/[,;]/)[0].trim();
  return first || authors;
}

// ─── Data sources ─────────────────────────────────────────────────────────────

async function fetchGoogleBooks(bookName) {
  try {
    const data = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(bookName)}&maxResults=20&printType=books&orderBy=relevance`
    ).then(r => r.json());
    if (!data.items?.length) return null;
    const candidates = data.items
      .filter(i => i.volumeInfo?.title && titleSimilar(i.volumeInfo.title, bookName))
      .filter(i => !isAggregator(i.volumeInfo));
    if (!candidates.length) return null;
    // Rank: ratings count first (real books have reviews), then description length
    const best = candidates.sort((a, b) => {
      const ra = a.volumeInfo.ratingsCount || 0;
      const rb = b.volumeInfo.ratingsCount || 0;
      if (rb !== ra) return rb - ra;
      return (b.volumeInfo.description?.length || 0) - (a.volumeInfo.description?.length || 0);
    })[0];
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

    const prompt = `אתה לא כותב סיכום *על* הספר "${book}".
אתה כותב את הסיכום *מתוך עולם הספר* — בקול המחבר, בקצב שלו, באווירה שלו.

הקול:
- הזדהה עם הקול הספציפי של המחבר. אורוול לא נשמע כמו הררי. סנט-אקזופרי לא נשמע כמו דוסטויבסקי.
- שמור על הקצב, אוצר המילים, הטון, האווירה. כאילו המחבר עצמו כתב את הסיכום הזה.
- כל פסקה צריכה להישמע כאילו יכלה להופיע בתוך הספר עצמו — לא ביקורת ספרות עליו.
- לא פארודיה, לא חיקוי גס. שיקוף אמיתי של הקול.
- אל תכתוב "הספר טוען ש..." או "המחבר מספר על...". כתוב מבפנים.

ראשית — בדיקת אמת:
- הספר שזוהה במקורות: "${identifiedTitle}"${identifiedAuthors ? ` מאת ${identifiedAuthors}` : ''}
- אם אתה לא מזהה את הספר הזה בוודאות, או שהמידע למטה מערב כמה ספרים שונים — החזר בדיוק: { "notFound": true, "reason": "סיבה קצרה" }
- אסור להמציא דמויות, ציטוטים, אירועים, מושגים או נושאים. אם אתה לא בטוח — השמט או החזר notFound.

החזר JSON תקין בלבד (ללא \`\`\`json וללא טקסט נוסף), בעברית. המבנה:

{
  "type": "fiction" אם זה ספר עלילה (רומן, סיפור, פנטזיה, וכו'), "nonfiction" אם זה ספר עיון (פילוסופיה, מדע, פסיכולוגיה, עסקים, היסטוריה, ביוגרפיה, עזרה עצמית),
  "openingLine": "משפט פתיחה אחד שנכתב בקול המחבר. לא 'הספר עוסק ב'. משפט שיכל לפתוח את הספר עצמו.",
  "overview": "פסקה (4-6 משפטים) שמציגה את עולם הספר מבפנים — לא 'הספר נכתב ב-1949 בידי אורוול' אלא 'אוקיאניה. שנת 1984. המפלגה כבר ניצחה.' תכניס את הקורא לעולם.",
  "whyItMatters": "פסקה (3-5 משפטים) — מה מתבהר אחרי הספר. למה הוא נשאר. מה הוא חושף. כתוב בקול המחבר, לא בקול מבקר.",
  "characters": [
    { "name": "שם הדמות", "role": "תפקיד קצר", "description": "2-4 משפטים על הדמות — בקול ובסגנון של המחבר. תאר את הדמות כפי שהמחבר היה מתאר אותה." }
  ],
  "concepts": [
    { "name": "שם המושג", "description": "2-4 משפטים שמציגים את המושג בקול המחבר — לא הסבר אקדמי, אלא איך המחבר מציג אותו בעצמו." }
  ],
  "plot": [
    { "title": "כותרת לחלק (לדוגמה: 'פתיחה — אוקיאניה', 'הכוכב השישי', 'מהפכת החקלאות')", "description": "3-5 משפטים שמתארים מה קורה — בקצב ובאווירה של המחבר. ספציפי. אם זה אורוול, יבש וצפוף. אם זה סנט-אקזופרי, רך ופיוטי." }
  ],
  "themes": [
    { "title": "שם הנושא", "explanation": "פסקה (3-5 משפטים) שמעמיקה בנושא דרך הקול של המחבר. לא 'הספר עוסק בכוח' אלא — כתוב על כוח כפי שהמחבר היה כותב על כוח." }
  ],
  "quotes": [
    { "text": "ציטוט אמיתי מהספר או פרפרזה נאמנה לקול אם אינך זוכר את המקור המדויק", "context": "משפט-שניים בקול המחבר על למה הציטוט הזה חשוב או מה הוא חושף" }
  ],
  "takeaways": ["נקודה כתובה בקול המחבר — לא 'הספר מלמד אותנו ש...' אלא משפט שיכל לבוא מתוך הספר עצמו"],
  "whoShouldRead": "פסקה (2-3 משפטים) שנכתבת כמעט כקריאה אישית של המחבר — 'אם אתה מאמין ש...', 'אם אי פעם עמדת מול...', בסגנונו."
}

כללים:
- JSON תקין בלבד. עברית קולחת ונאמנה לקול הספציפי של המחבר.
- אם type=fiction: מלא characters (3-5) ו-plot (4-6 חלקים). השאר concepts כמערך ריק [].
- אם type=nonfiction: מלא concepts (4-6) ו-plot (4-6 שלבי טיעון). השאר characters כמערך ריק [].
- themes: 3-5 נושאים. quotes: 2-4. takeaways: 4-6 נקודות.
- ספציפי לספר הזה ולקול הזה. ללא משפטים גנריים.
- כל מילה צריכה להישמע *כמו המחבר*, לא כמו מנוע שמסכם.
- אסור להמציא. אם אין מספיק מידע על פרט — השמט אותו.

${rawContext ? `\nמידע אמיתי על הספר ממקורות חיצוניים (השתמש לעיגון, אל תצטט מילולית):\n${rawContext.slice(0, 4500)}` : ''}`;

    const geminiRes = await fetch(GEMINI_JSON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: 'אתה כותב ספרים, לא מסכם אותם. אתה מזדהה לחלוטין עם הקול של כל מחבר. ענה ב-JSON תקין בלבד, בעברית.' }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 8000, responseMimeType: 'application/json' },
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

    if (!structured.openingLine && !structured.overview) {
      return res.status(500).json({ error: 'תגובת AI לא תקינה. נסה שוב.' });
    }

    const result = {
      title: cleanTitle(heWiki?.title || google?.title || enWiki?.title || openLib?.title || book),
      authors: primaryAuthor(google?.authors || openLib?.authors) || null,
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
