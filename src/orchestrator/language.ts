/**
 * Simple language detection heuristic.
 * Uses Unicode script detection for Indian languages.
 * Falls back to 'en' if uncertain.
 */

const SCRIPT_PATTERNS: Array<{ lang: string; pattern: RegExp; minChars: number }> = [
  { lang: 'hi', pattern: /[\u0900-\u097F]/g, minChars: 3 },    // Devanagari (Hindi)
  { lang: 'kn', pattern: /[\u0C80-\u0CFF]/g, minChars: 3 },    // Kannada
  { lang: 'ta', pattern: /[\u0B80-\u0BFF]/g, minChars: 3 },    // Tamil
  { lang: 'te', pattern: /[\u0C00-\u0C7F]/g, minChars: 3 },    // Telugu
  { lang: 'ml', pattern: /[\u0D00-\u0D7F]/g, minChars: 3 },    // Malayalam
  { lang: 'bn', pattern: /[\u0980-\u09FF]/g, minChars: 3 },    // Bengali
  { lang: 'gu', pattern: /[\u0A80-\u0AFF]/g, minChars: 3 },    // Gujarati
  { lang: 'pa', pattern: /[\u0A00-\u0A7F]/g, minChars: 3 },    // Gurmukhi (Punjabi)
  { lang: 'mr', pattern: /[\u0900-\u097F]/g, minChars: 3 },    // Marathi uses Devanagari too
  { lang: 'ar', pattern: /[\u0600-\u06FF]/g, minChars: 3 },    // Arabic
  { lang: 'zh', pattern: /[\u4E00-\u9FFF]/g, minChars: 2 },    // Chinese
  { lang: 'ja', pattern: /[\u3040-\u309F\u30A0-\u30FF]/g, minChars: 2 }, // Japanese
  { lang: 'ko', pattern: /[\uAC00-\uD7AF]/g, minChars: 2 },    // Korean
];

// Common Hindi words written in Latin script (Hinglish detection)
const HINGLISH_WORDS = [
  'kya', 'hai', 'nahi', 'mujhe', 'chahiye', 'kaise', 'kab', 'kidhar',
  'bhai', 'yaar', 'acha', 'theek', 'haan', 'nhi', 'bol', 'bata',
  'kitna', 'kahan', 'kyun', 'abhi', 'kal', 'aaj', 'mera', 'tera',
  'doodh', 'paani', 'khana', 'wala', 'dena', 'lena', 'karna',
];

export function detectLanguage(text: string): string {
  if (!text || text.trim().length === 0) return 'en';

  // Check script-based detection first (non-Latin scripts)
  for (const { lang, pattern, minChars } of SCRIPT_PATTERNS) {
    const matches = text.match(pattern);
    if (matches && matches.length >= minChars) {
      // Special case: Devanagari could be Hindi or Marathi
      // Default to Hindi as it's more common in our target market
      return lang === 'mr' ? 'hi' : lang;
    }
  }

  // Check for Hinglish (Hindi written in Latin script)
  const words = text.toLowerCase().split(/\s+/);
  const hinglishCount = words.filter(w => HINGLISH_WORDS.includes(w)).length;
  if (hinglishCount >= 2 || (hinglishCount >= 1 && words.length <= 5)) {
    return 'hi'; // Treat Hinglish as Hindi
  }

  // Kannada romanized words (common in Bangalore)
  const kannadaRomanized = ['hegidira', 'hogi', 'banni', 'enu', 'illa', 'houdu', 'beda', 'guru', 'swalpa'];
  const kannadaCount = words.filter(w => kannadaRomanized.includes(w)).length;
  if (kannadaCount >= 2) {
    return 'kn';
  }

  return 'en';
}
