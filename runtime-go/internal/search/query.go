package search

import (
	"strings"
	"unicode"

	"runtime-go/internal/observability"
)

// ErrCodeQueryParse is the AppError code for malformed query strings.
const ErrCodeQueryParse = "QUERY_PARSE_ERROR"

// Node is a node of the parsed query condition tree.
type Node interface{ node() }

// Term matches documents containing a token. Field scopes the match to a
// named field (empty = title+body); Prefix enables prefix-fuzzy matching
// ("foo*" matches "foo", "foobar", ...). toks caches Tokenize(Value) so
// repeated evaluation across shards and queries skips re-tokenizing; it is
// nil for Terms built outside ParseQuery and for prefix terms.
type Term struct {
	Field  string
	Value  string
	Prefix bool
	toks   []string
}

// And matches the intersection of its children.
type And struct{ Children []Node }

// Or matches the union of its children.
type Or struct{ Children []Node }

// Not matches the complement of its child within the live document set.
type Not struct{ Child Node }

func (Term) node() {}
func (And) node()  {}
func (Or) node()   {}
func (Not) node()  {}

// ParseQuery parses a query string into a condition tree.
//
// Grammar (whitespace-separated lexemes, no parentheses):
//
//	or    := and ( "OR" and )*
//	and   := unary+              // juxtaposition means AND
//	unary := "-" unary | term
//	term  := [field ":"] value ["*"]
//
// "OR" is only an operator in upper case; lowercase "or" is an ordinary
// term. A trailing "*" marks a prefix-fuzzy term.
func ParseQuery(q string) (Node, error) {
	pieces := strings.Fields(q)
	if len(pieces) == 0 {
		return nil, parseErr("empty query", "")
	}
	p := &parser{pieces: pieces}
	n, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if p.pos < len(p.pieces) {
		return nil, parseErr("unexpected trailing token", p.pieces[p.pos])
	}
	return n, nil
}

func parseErr(msg, token string) *observability.AppError {
	return observability.NewAppError(ErrCodeQueryParse, msg).WithContext("token", token)
}

type parser struct {
	pieces []string
	pos    int
}

func (p *parser) parseOr() (Node, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for p.pos < len(p.pieces) && p.pieces[p.pos] == "OR" {
		p.pos++
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		left = Or{Children: []Node{left, right}}
	}
	return left, nil
}

func (p *parser) parseAnd() (Node, error) {
	var children []Node
	for p.pos < len(p.pieces) && p.pieces[p.pos] != "OR" {
		n, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		children = append(children, n)
	}
	switch len(children) {
	case 0:
		return nil, parseErr("expected term", "")
	case 1:
		return children[0], nil
	}
	return And{Children: children}, nil
}

func (p *parser) parseUnary() (Node, error) {
	piece := p.pieces[p.pos]
	if strings.HasPrefix(piece, "-") {
		p.pos++
		if rest := piece[1:]; rest != "" {
			n, err := parseTermPiece(rest)
			if err != nil {
				return nil, err
			}
			return Not{Child: n}, nil
		}
		// A bare "-" negates the following unary expression.
		if p.pos >= len(p.pieces) || p.pieces[p.pos] == "OR" {
			return nil, parseErr("dangling NOT operator", "-")
		}
		n, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return Not{Child: n}, nil
	}
	p.pos++
	return parseTermPiece(piece)
}

func parseTermPiece(piece string) (Node, error) {
	prefix := strings.HasSuffix(piece, "*")
	if prefix {
		piece = strings.TrimSuffix(piece, "*")
	}
	field := ""
	if i := strings.IndexByte(piece, ':'); i >= 0 {
		field = strings.ToLower(piece[:i])
		piece = piece[i+1:]
		if !validFieldName(field) {
			return nil, parseErr("invalid field name", field)
		}
	}
	if piece == "" {
		return nil, parseErr("empty term value", piece)
	}
	if strings.ContainsRune(piece, '*') {
		return nil, parseErr("'*' is only allowed as a suffix", piece)
	}
	value := strings.ToLower(piece)
	t := Term{Field: field, Value: value, Prefix: prefix}
	if !prefix {
		t.toks = Tokenize(value)
	}
	return t, nil
}

func validFieldName(f string) bool {
	if f == "" {
		return false
	}
	for _, r := range f {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' {
			return false
		}
	}
	return true
}
