"""The imported Neon scripts select native AWS request behavior for S3."""
from pathlib import Path
import subprocess
import pytest

ROOT = Path(__file__).resolve().parents[2]

@pytest.mark.parametrize("script", ["bootstrap.sh", "smoke.sh"])
@pytest.mark.parametrize("endpoint, expected", [
    ("https://s3.us-east-1.amazonaws.com", "AWS"),
    ("https://s3.eu-central-1.amazonaws.com/", "AWS"),
    ("https://s3.cn-north-1.amazonaws.com.cn", "AWS"),
    ("https://account.r2.cloudflarestorage.com", "Cloudflare"),
])
def test_endpoint_selects_rclone_provider(script, endpoint, expected):
    text = (ROOT / "green/src/resources/io/github/getcolors/neon/tools/ansible" / script).read_text()
    selection = text[text.index('case "$endpoint" in'):text.index('export RCLONE_CONFIG_R2_PROVIDER')]
    result = subprocess.run(["bash", "-eu", "-c", 'endpoint="$1"\n' + selection + '\nprintf "%s" "$RCLONE_CONFIG_R2_PROVIDER"', "provider-test", endpoint], text=True, capture_output=True, check=True)
    assert result.stdout == expected
