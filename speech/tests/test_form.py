from leslie_speech.server import form_fields


def test_form_fields_reads_the_browser_formdata_layout():
    boundary = "----leslie"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode() + b"RIFF\x00\x01binary\r\n" + (
        f"\r\n--{boundary}\r\n"
        'Content-Disposition: form-data; name="model"\r\n\r\n'
        "large-v3-turbo\r\n"
        f"--{boundary}--\r\n"
    ).encode()
    fields = form_fields(f"multipart/form-data; boundary={boundary}", body)
    assert fields["file"] == b"RIFF\x00\x01binary\r\n"
    assert fields["model"] == b"large-v3-turbo"
