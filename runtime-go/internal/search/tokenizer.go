package search

import "unicode"

// Tokenize splits text into lowercase index terms.
//
// Runs of letters and digits form word tokens (e.g. "hello", "go1"). Runs of
// CJK (Han) ideographs are emitted as overlapping bigrams so Chinese text is
// searchable without a dictionary; a single isolated Han rune falls back to a
// unigram. All other characters act as separators.
func Tokenize(text string) []string {
	var out []string
	var word []rune
	var han []rune

	flushWord := func() {
		if len(word) > 0 {
			out = append(out, string(word))
			word = word[:0]
		}
	}
	flushHan := func() {
		switch len(han) {
		case 0:
		case 1:
			out = append(out, string(han))
		default:
			for i := 0; i+2 <= len(han); i++ {
				out = append(out, string(han[i:i+2]))
			}
		}
		han = han[:0]
	}

	for _, r := range text {
		switch {
		case unicode.Is(unicode.Han, r):
			flushWord()
			han = append(han, r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			flushHan()
			word = append(word, unicode.ToLower(r))
		default:
			flushWord()
			flushHan()
		}
	}
	flushWord()
	flushHan()
	return out
}
