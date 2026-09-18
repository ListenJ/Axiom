package search

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"math"
)

// 二进制内部查询协议 v1（P2-12 热路径优化）：
// 相比 JSON，消除反射编码/逐字段拼接与键名字节，显著降低每扇出 RPC 的
// CPU 序列化开销与跨节点字节数。兼容性：客户端按响应 Content-Type 嗅探，
// 老节点（仅 JSON）自动回退解码；服务端仅在收到二进制请求时才回二进制。

const queryBinContentType = "application/x-search-query-bin"

// ── 请求：'S''Q'0x01, uvarint(limit), str(query), uvarint(n) + n×uvarint(shard) ──

func appendQueryBinReq(dst []byte, q string, shards []int, limit int) []byte {
	dst = append(dst, 'S', 'Q', 0x01)
	dst = binary.AppendUvarint(dst, uint64(limit))
	dst = binary.AppendUvarint(dst, uint64(len(q)))
	dst = append(dst, q...)
	dst = binary.AppendUvarint(dst, uint64(len(shards)))
	for _, s := range shards {
		if s < 0 {
			s = 0
		}
		dst = binary.AppendUvarint(dst, uint64(s))
	}
	return dst
}

func decodeQueryBinReq(r io.Reader) (internalQueryRequest, error) {
	br := bufio.NewReader(r)
	magic := make([]byte, 3)
	if _, err := io.ReadFull(br, magic); err != nil || magic[0] != 'S' || magic[1] != 'Q' || magic[2] != 0x01 {
		return internalQueryRequest{}, fmt.Errorf("bad binary query magic")
	}
	req := internalQueryRequest{}
	limit, err := binary.ReadUvarint(br)
	if err != nil {
		return req, err
	}
	req.Limit = int(limit)
	qLen, err := binary.ReadUvarint(br)
	if err != nil {
		return req, err
	}
	qb := make([]byte, qLen)
	if _, err := io.ReadFull(br, qb); err != nil {
		return req, err
	}
	req.Query = string(qb)
	n, err := binary.ReadUvarint(br)
	if err != nil {
		return req, err
	}
	if n > 1<<20 {
		return req, fmt.Errorf("shards count too large: %d", n)
	}
	req.Shards = make([]int, 0, n)
	for i := uint64(0); i < n; i++ {
		s, err := binary.ReadUvarint(br)
		if err != nil {
			return req, err
		}
		req.Shards = append(req.Shards, int(s))
	}
	return req, nil
}

// ── 响应：'S''R'0x01, uvarint(n), n×(str(id), f64(score LE), str(title)) ──

func appendQueryBinResp(dst []byte, hits []Hit) []byte {
	dst = append(dst, 'S', 'R', 0x01)
	dst = binary.AppendUvarint(dst, uint64(len(hits)))
	for _, h := range hits {
		dst = binary.AppendUvarint(dst, uint64(len(h.ID)))
		dst = append(dst, h.ID...)
		score := h.Score
		if math.IsNaN(score) || math.IsInf(score, 0) {
			score = 0
		}
		dst = binary.LittleEndian.AppendUint64(dst, math.Float64bits(score))
		dst = binary.AppendUvarint(dst, uint64(len(h.Title)))
		dst = append(dst, h.Title...)
	}
	return dst
}

func decodeQueryBinResp(r io.Reader) ([]Hit, error) {
	br := bufio.NewReader(r)
	magic := make([]byte, 3)
	if _, err := io.ReadFull(br, magic); err != nil || magic[0] != 'S' || magic[1] != 'R' || magic[2] != 0x01 {
		return nil, fmt.Errorf("bad binary response magic")
	}
	n, err := binary.ReadUvarint(br)
	if err != nil {
		return nil, err
	}
	hits := make([]Hit, 0, n)
	for i := uint64(0); i < n; i++ {
		idLen, err := binary.ReadUvarint(br)
		if err != nil {
			return nil, err
		}
		idb := make([]byte, idLen)
		if _, err := io.ReadFull(br, idb); err != nil {
			return nil, err
		}
		var scoreBits [8]byte
		if _, err := io.ReadFull(br, scoreBits[:]); err != nil {
			return nil, err
		}
		titleLen, err := binary.ReadUvarint(br)
		if err != nil {
			return nil, err
		}
		tb := make([]byte, titleLen)
		if _, err := io.ReadFull(br, tb); err != nil {
			return nil, err
		}
		hits = append(hits, Hit{
			ID:    string(idb),
			Score: math.Float64frombits(binary.LittleEndian.Uint64(scoreBits[:])),
			Title: string(tb),
		})
	}
	return hits, nil
}

// sniffBinaryResponse 判定对端是否以二进制协议应答（老节点回 JSON 时走原解码）。
// 优化：直接传 Content-Type 字符串而非完整 Header，避免 DoRaw 的 Header.Clone。
func sniffBinaryResponse(contentType string) bool {
	return contentType == queryBinContentType
}
