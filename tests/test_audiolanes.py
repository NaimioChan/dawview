"""用户音频轨（dawview/audiolanes.py + 服务端那两条接口）的单元测试。

覆盖：数据收窄（坏 JSON 不让服务起不来）、落盘 / 读回、媒体上传与去重、
Range 取音频、路径越界、上传超限、以及"存完广播给别的窗口"。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from dawview.audiolanes import (MAX_MEDIA_BYTES, AudioLaneStore, audio_dir_for,
                                clean_lanes, safe_media_name)
from dawview.server import LocalServer

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DEMO = json.loads((ROOT / "docs" / "demo-project.json").read_text(encoding="utf-8"))

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get(server, path, *, headers: dict | None = None):
    url = f"http://127.0.0.1:{server.port}{path}"
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with OPENER.open(req, timeout=5) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def post_bytes(server, path, data: bytes, *, ctype: str = "application/octet-stream"):
    url = f"http://127.0.0.1:{server.port}{path}"
    req = urllib.request.Request(url, data=data, method="POST",
                                headers={"Content-Type": ctype})
    try:
        with OPENER.open(req, timeout=5) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def post_json(server, path, obj):
    return post_bytes(server, path, json.dumps(obj).encode("utf-8"),
                      ctype="application/json")


@pytest.fixture()
def store_dir(tmp_path: Path) -> Path:
    return tmp_path / ".dawview"


@pytest.fixture()
def server(store_dir: Path, tmp_path: Path):
    srv = LocalServer(DEMO, WEB, port=0, prefs_path=tmp_path / "prefs.json",
                      audio_dir=store_dir).start()
    yield srv
    srv.stop()


def lane(lane_id="al1", clip_id="ac1", **clip):
    data = {"id": clip_id, "name": "demo.wav", "file": "media/abcd1234-demo.wav",
            "startTick": 1920, "srcOffsetSec": 0.5, "lengthSec": 4.0, "srcDurSec": 8.0}
    data.update(clip)
    return {"id": lane_id, "name": "参考", "muted": False, "clips": [data]}


# --------------------------------------------------------------- 数据收窄

def test_clean_lanes_keeps_good_data():
    lanes, dropped = clean_lanes([lane()])
    assert dropped == 0
    assert lanes[0]["clips"][0] == {
        "id": "ac1", "name": "demo.wav", "file": "media/abcd1234-demo.wav",
        "startTick": 1920, "srcOffsetSec": 0.5, "lengthSec": 4.0, "srcDurSec": 8.0,
    }


def test_clean_lanes_drops_junk_and_clamps():
    raw = [
        lane(clip_id="ok"),
        {"id": "al2", "name": "x", "clips": [
            {"id": "bad1", "file": "media/a.wav"},                      # 没有长度
            {"id": "bad2", "file": "../../etc/passwd", "lengthSec": 1}, # 路径越界
            {"id": "bad3", "file": "media/b.wav", "lengthSec": 1,
             "srcOffsetSec": 999, "srcDurSec": 2},                      # offset 超出源
            "不是对象",
        ]},
        {"name": "没有 id 的轨"},
        "不是对象",
    ]
    lanes, dropped = clean_lanes(raw)
    assert len(lanes) == 2
    assert lanes[1]["clips"][0]["srcOffsetSec"] == pytest.approx(2 - 0.02)  # 夹到源里
    assert dropped == 5
    # 认不得的字段不会存回去
    lanes2, _ = clean_lanes([lane(clip_id="ok", 乱来="x", startTick=-5)])
    assert set(lanes2[0]) == {"id", "name", "muted", "clips"}
    assert lanes2[0]["clips"][0]["startTick"] == 0


def test_clean_lanes_tolerates_nan_and_strings():
    lanes, _ = clean_lanes([lane(clip_id="ok", startTick="1920", srcOffsetSec=float("nan"),
                                 lengthSec=12.0)])          # 长度超过源 -> 夹到源里
    clip = lanes[0]["clips"][0]
    assert clip["startTick"] == 1920
    assert clip["srcOffsetSec"] == 0.0
    assert clip["lengthSec"] == 8.0
    # 长度本身是 NaN / inf：猜不出它该多长，整条丢掉（留着就是个 0 长度的隐形片段）
    assert clean_lanes([lane(clip_id="ok", lengthSec=float("nan"))])[0][0]["clips"] == []
    assert clean_lanes([lane(clip_id="ok", lengthSec=float("inf"))])[1] == 1


def test_media_dedupe_keeps_one_copy(store_dir: Path):
    """同一个文件（同名同内容）重复导入只占一份。"""
    store = AudioLaneStore(store_dir)
    data = b"ID3" + b"\x00" * 64
    first = store.store_media(lambda n: iter([data]), len(data), "9月参考.wav")
    second = store.store_media(lambda n: iter([data]), len(data), "9月参考.wav")
    assert first["dup"] is False and second["dup"] is True
    assert first["file"] == second["file"]
    assert len(list((store_dir / "media").iterdir())) == 1


def test_clean_lanes_of_non_list():
    assert clean_lanes(None) == ([], 0)
    assert clean_lanes({"lanes": []})[0] == []


# ------------------------------------------------------------------ 文件名

def test_safe_media_name_keeps_ascii_only():
    # 中文 / 空格 / 括号一律换成 '-'；哈希前缀留着当去重依据
    assert safe_media_name("我的 参考 混音 (1).mp3", "abcdef1234567890") == "abcdef12-1.mp3"
    assert safe_media_name("Take 03 (final).WAV", "abcdef1234567890") == "abcdef12-Take-03-final.wav"
    assert safe_media_name("..", "deadbeefcafe") == "deadbeef-audio.audio"    # 没名字可留
    assert safe_media_name("noext", "0123456789ab") == "01234567-noext.audio"
    assert len(safe_media_name("x" * 300 + ".flac", "f" * 40)) <= 8 + 1 + 80 + 5   # 名字被截断


def test_safe_media_name_strips_dirs():
    assert safe_media_name("C:\\a\\b\\take.wav", "0" * 40).endswith("-take.wav")


# --------------------------------------------------------------- 存取往返

def test_store_round_trip(store_dir: Path):
    s1 = AudioLaneStore(store_dir)
    assert s1.load() == []
    lanes, saved = s1.save([lane()])
    assert saved is True and s1.writable is True
    blob = json.loads((store_dir / "audio-lanes.json").read_text(encoding="utf-8"))
    assert blob["version"] == 1 and blob["lanes"][0]["id"] == "al1"

    s2 = AudioLaneStore(store_dir)                 # 换个实例读回来
    assert s2.load() == lanes
    snap = s2.snapshot()
    assert snap["dir"] == str(store_dir) and snap["writable"] is True


def test_store_survives_corrupt_file(store_dir: Path):
    store_dir.mkdir(parents=True)
    (store_dir / "audio-lanes.json").write_text("{ 这不是 JSON", encoding="utf-8")
    assert AudioLaneStore(store_dir).load() == []
    # 写入之后照样能存（不会被坏文件卡住）
    assert AudioLaneStore(store_dir).save([lane()])[1] is True


def test_store_unwritable_dir_still_works_in_memory(tmp_path: Path, monkeypatch):
    store_dir = tmp_path / ".dawview"
    store = AudioLaneStore(store_dir)

    def boom(*a, **kw):
        raise OSError(13, "read-only")

    monkeypatch.setattr(Path, "write_text", boom)
    lanes, saved = store.save([lane()])
    assert saved is False and store.writable is False
    assert store.load() == lanes                   # 内存那份还在


def test_media_path_rejects_traversal(store_dir: Path):
    store = AudioLaneStore(store_dir)
    store.store_media(lambda n: iter([b"abc"]), 3, "a.wav")
    assert store.media_path("media/../audio-lanes.json") is None
    assert store.media_path("media/sub/a.wav") is None
    assert store.media_path("/etc/passwd") is None
    assert store.media_path("media/nope.wav") is None
    assert store.media_path("media/") is None
    assert store.find_media("../../audio-lanes.json") is None
    assert len(list((store_dir / "media").iterdir())) == 1


# ------------------------------------------------------------------- 媒体

def test_store_media_dedupes_and_names_with_hash(store_dir: Path):
    store = AudioLaneStore(store_dir)
    payload = b"RIFF" + b"\x00" * 100
    first = store.store_media(lambda n: iter([payload]), len(payload), "我的 take.wav")
    assert first["dup"] is False and first["bytes"] == len(payload)
    assert first["file"].startswith("media/") and first["file"].endswith(".wav")
    assert (store_dir / first["file"]).read_bytes() == payload

    again = store.store_media(lambda n: iter([payload]), len(payload), "我的 take.wav")
    assert again["dup"] is True and again["file"] == first["file"]
    assert len(list((store_dir / "media").iterdir())) == 1      # 只占一份


def test_store_media_cleans_up_partial_upload(store_dir: Path):
    store = AudioLaneStore(store_dir)

    def explode(n):
        yield b"half"
        raise OSError("连接断了")

    with pytest.raises(OSError):
        store.store_media(explode, 999, "x.wav")
    assert list((store_dir / "media").iterdir()) == []          # 没留垃圾


def test_store_media_rejects_too_big(store_dir: Path):
    store = AudioLaneStore(store_dir)
    with pytest.raises(ValueError):
        store.store_media(lambda n: iter([]), MAX_MEDIA_BYTES + 1, "big.wav")


def test_audio_dir_for_beside_project(tmp_path: Path):
    proj = tmp_path / "song.cpr"
    assert audio_dir_for(proj) == tmp_path / ".dawview"
    assert audio_dir_for(proj, tmp_path / "elsewhere") == tmp_path / "elsewhere"


# ------------------------------------------------------------------- 接口

def test_audiolanes_get_empty(server):
    status, headers, body = get(server, "/audiolanes.json")
    assert status == 200
    data = json.loads(body)
    assert data["lanes"] == [] and data["writable"] is True
    assert "no-store" in headers.get("Cache-Control", "")


def test_audiolanes_post_saves_and_reads_back(server, store_dir: Path):
    status, res = post_json(server, "/audiolanes", {"lanes": [lane()]})
    assert status == 200 and res["ok"] is True and res["saved"] is True
    assert res["lanes"][0]["id"] == "al1"
    on_disk = json.loads((store_dir / "audio-lanes.json").read_text(encoding="utf-8"))
    assert on_disk["lanes"][0]["clips"][0]["lengthSec"] == 4.0
    # GET 拿到的是刚存的那份
    assert json.loads(get(server, "/audiolanes.json")[2])["lanes"] == res["lanes"]


def test_audiolanes_post_cleans_junk(server):
    status, res = post_json(server, "/audiolanes", {"lanes": [lane(clip_id="ok"),
                                                              {"id": "al9"}]})
    assert status == 200
    assert len(res["lanes"]) == 2 and res["lanes"][1]["clips"] == []


def test_audiolanes_post_rejects_bad_json(server):
    status, res = post_bytes(server, "/audiolanes", b"{ nope",
                             ctype="application/json")
    assert status == 400 and res["ok"] is False


def test_media_upload_serve_and_range(server, store_dir: Path):
    payload = bytes(range(256)) * 4                        # 1024 字节，内容可校验
    status, res = post_bytes(server, "/media?name=%E6%B5%8B%E8%AF%95.wav", payload)
    assert status == 200 and res["ok"] is True
    name = res["file"].split("/", 1)[1]

    status, headers, body = get(server, f"/media/{name}")
    assert status == 200 and body == payload
    assert headers["Content-Type"] == "audio/wav"
    assert headers["Accept-Ranges"] == "bytes"
    assert "immutable" in headers.get("Cache-Control", "")

    status, headers, part = get(server, f"/media/{name}", headers={"Range": "bytes=10-19"})
    assert status == 206 and part == payload[10:20]
    assert headers["Content-Range"] == f"bytes 10-19/{len(payload)}"

    status, _, tail = get(server, f"/media/{name}", headers={"Range": "bytes=-8"})
    assert status == 206 and tail == payload[-8:]

    # 越界范围 -> 416，别回半个文件
    assert get(server, f"/media/{name}", headers={"Range": "bytes=9999-10000"})[0] == 416


def test_media_upload_dedupes(server, store_dir: Path):
    from urllib.parse import quote
    data = b"WAVE" * 10
    q = quote("参考 混音.wav")
    first = post_bytes(server, f"/media?name={q}", data)[1]
    assert first["dup"] is False
    again = post_bytes(server, f"/media?name={q}", data)[1]
    assert again["dup"] is True and again["file"] == first["file"]
    assert len(list((store_dir / "media").iterdir())) == 1     # 只占一份


def test_media_missing_and_traversal_are_404(server):
    assert get(server, "/media/nope.wav")[0] == 404
    assert get(server, "/media/..%2Faudio-lanes.json")[0] == 404
    assert get(server, "/media/%2e%2e%2faudio-lanes.json")[0] == 404


def test_media_upload_without_content_length_is_411(server):
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
    # Transfer-Encoding 走 chunked：没 Content-Length -> 明确回 411，而不是卡在那儿
    conn.putrequest("POST", "/media?name=a.wav")
    conn.putheader("Transfer-Encoding", "chunked")
    conn.endheaders()
    res = conn.getresponse()
    assert res.status == 411
    conn.close()


def test_no_audio_dir_means_503(server):
    bare = LocalServer(DEMO, WEB, port=0).start()
    try:
        assert json.loads(get(bare, "/audiolanes.json")[2])["writable"] is False
        assert post_bytes(bare, "/media?name=a.wav", b"xx")[0] == 503
        assert post_json(bare, "/audiolanes", {"lanes": []})[0] == 503
    finally:
        bare.stop()


def test_audiolanes_post_broadcasts_to_other_windows(server):
    """一个窗口改了音频轨，别的窗口（OBS 浏览器源）要跟着变。"""
    from test_server import SseClient, wait_until
    client = SseClient(server.port)
    try:
        assert wait_until(lambda: server.clients >= 1)
        # 报一个**不存在的** client id：服务端按它跳过回声，报 c1 的话
        # 正好就是那个 SSE 客户端的 id（第一个连上的就叫 c1），广播会被跳过
        post_json(server, "/audiolanes", {"lanes": [lane()], "client": "别家窗口"})
        data = client.read_until("audiolanes")            # 只返回事件负载
        assert data["lanes"][0]["id"] == "al1"
        assert data["lanes"][0]["clips"][0]["lengthSec"] == 4.0
    finally:
        client.close()
