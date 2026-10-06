import os
import sys
import unittest
from pathlib import Path

os.environ["EMBED_SKIP_MODEL_LOAD"] = "1"

import numpy as np
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import create_app  # noqa: E402


class FakeEncoder:
    model_id = "BAAI/bge-m3"
    dim = 1024
    device = "cuda:0"
    max_seq_length = 512
    gpu_name = "Fake GPU"

    def encode(self, texts, batch_size, normalize_embeddings):
        return np.ones((len(texts), self.dim), dtype=np.float32)

    def count_tokens(self, texts):
        return sum(len(t.split()) for t in texts)


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(create_app(FakeEncoder()))

    def test_health(self):
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["dim"], 1024)
        self.assertEqual(res.json()["device"], "cuda:0")

    def test_embeddings_string_and_list(self):
        res = self.client.post("/v1/embeddings", json={"model": "BAAI/bge-m3", "input": "hello"})
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(len(body["data"]), 1)
        self.assertEqual(len(body["data"][0]["embedding"]), 1024)
        self.assertEqual(body["usage"]["total_tokens"], 1)

        res = self.client.post(
            "/v1/embeddings",
            json={"model": "BAAI/bge-m3", "input": ["hello", "world"]},
        )
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(len(res.json()["data"]), 2)

    def test_rejects_unknown_model_and_empty_input(self):
        self.assertEqual(
            self.client.post("/v1/embeddings", json={"model": "other", "input": "x"}).status_code,
            400,
        )
        self.assertEqual(
            self.client.post("/v1/embeddings", json={"model": "BAAI/bge-m3", "input": []}).status_code,
            400,
        )


if __name__ == "__main__":
    unittest.main()
