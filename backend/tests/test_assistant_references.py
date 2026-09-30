from app.llm.prompt import RefInfo, _refs_block, enforce_reference_tags, reference_tag_issues


def test_paired_soundtrack_labels_match_native_h3_order():
    refs = [RefInfo(kind="audio", name="music.wav"),
            RefInfo(kind="video", name="voice.mp4", with_audio=True),
            RefInfo(kind="video", name="silent.mp4")]
    block = _refs_block(refs)
    assert "<Audio 1> = Звуковая дорожка видео voice.mp4" in block
    assert "<Audio 2> = music.wav" in block
    assert "<Video 2> = silent.mp4" in block
    assert reference_tag_issues(refs, "<Video 1> <Video 2> <Audio 1> <Audio 2>") == []
    assert any("<Audio 2>" in issue for issue in reference_tag_issues(refs, "<Video 1> <Video 2> <Audio 1>"))
    fixed = enforce_reference_tags(refs, "subject_definitions:\n<Video 1> <Video 2>\n")
    assert reference_tag_issues(refs, fixed) == []


def test_disabled_soundtrack_does_not_take_an_audio_label():
    refs = [RefInfo(kind="video", name="clip.mp4"), RefInfo(kind="audio", name="music.wav")]
    assert "<Audio 1> = music.wav" in _refs_block(refs)
    assert reference_tag_issues(refs, "<Video 1> <Audio 1>") == []
