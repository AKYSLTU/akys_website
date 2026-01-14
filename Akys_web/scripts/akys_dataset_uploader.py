#!/usr/bin/env python3
"""
AKYS dataset uploader for Cloudflare R2.

Usage:
  python scripts/akys_dataset_uploader.py "/path/to/Akys_Horizons_Utenos_g_2025-10-02_06-39-41_F+R"
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Optional

import boto3
from botocore.config import Config


def load_env():
  required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
  missing = [k for k in required if not os.getenv(k)]
  if missing:
    sys.exit(f"Missing required environment variables: {', '.join(missing)}")

  return {
    "account_id": os.environ["R2_ACCOUNT_ID"],
    "access_key_id": os.environ["R2_ACCESS_KEY_ID"],
    "secret_access_key": os.environ["R2_SECRET_ACCESS_KEY"],
    "bucket": os.environ.get("R2_BUCKET_DATASETS", "road-horizon-datasets"),
  }


def find_single_zip(folder: Path) -> Path:
  zips = list(folder.glob("*.zip"))
  if len(zips) != 1:
    sys.exit(f"Expected exactly one .zip in {folder}, found {len(zips)}")
  return zips[0]

def find_public_info(folder: Path) -> Path:
  candidate = folder / "dataset_public.json"
  if candidate.exists():
    return candidate
  sys.exit(f"dataset_public.json not found in {folder}")


def find_screenshots(folder: Path) -> List[Path]:
  exts = {".jpg", ".jpeg", ".png", ".webp", ".avif"}
  shots: List[Path] = []
  for p in folder.rglob("*"):
    if (
      p.is_file()
      and p.suffix.lower() in exts
      and (
        p.name.lower().startswith("screenshot_")
        or p.name.lower().startswith("front_")
        or p.name.lower().startswith("rear_")
      )
    ):
      shots.append(p)
  return shots


def r2_client(env):
  endpoint = f"https://{env['account_id']}.r2.cloudflarestorage.com"
  session = boto3.session.Session()
  return session.client(
    service_name="s3",
    endpoint_url=endpoint,
    aws_access_key_id=env["access_key_id"],
    aws_secret_access_key=env["secret_access_key"],
    config=Config(s3={"addressing_style": "path"}),
  )


def upload_file(client, bucket: str, key: str, filepath: Path, content_type: Optional[str] = None):
  extra = {}
  if content_type:
    extra["ContentType"] = content_type
  client.upload_file(str(filepath), bucket, key, ExtraArgs=extra)


def guess_content_type(path: Path) -> str:
  if path.suffix.lower() == ".json":
    return "application/json"
  if path.suffix.lower() in {".jpg", ".jpeg"}:
    return "image/jpeg"
  if path.suffix.lower() == ".png":
    return "image/png"
  if path.suffix.lower() == ".webp":
    return "image/webp"
  if path.suffix.lower() == ".avif":
    return "image/avif"
  return "application/octet-stream"


def parse_info(info_files: List[Path]):
  if not info_files:
    return None
  try:
    return json.loads(info_files[0].read_text())
  except Exception:
    return None


def main():
  parser = argparse.ArgumentParser(description="Upload AKYS dataset bundle to R2")
  parser.add_argument("folder", help="Path to local dataset folder")
  args = parser.parse_args()

  folder = Path(args.folder).expanduser().resolve()
  if not folder.exists() or not folder.is_dir():
    sys.exit(f"Folder not found: {folder}")

  env = load_env()
  client = r2_client(env)

  zip_path = find_single_zip(folder)
  slug = zip_path.stem

  info_files = [find_public_info(folder)]
  screenshots = find_screenshots(folder)

  written_keys = []

  # Upload info files
  for info in info_files:
    key = f"ready/{slug}/dataset_info.json"
    upload_file(client, env["bucket"], key, info, content_type="application/json")
    written_keys.append(key)

  # Upload screenshots
  for shot in screenshots:
    key = f"ready/{slug}/screenshots/{shot.name}"
    upload_file(client, env["bucket"], key, shot, content_type=guess_content_type(shot))
    written_keys.append(key)

  # Upload zip (private)
  private_key = f"private/{slug}.zip"
  upload_file(client, env["bucket"], private_key, zip_path, content_type="application/zip")
  written_keys.append(private_key)

  info_data = parse_info(info_files)
  summary = ""
  if info_data:
    date = info_data.get("date") or info_data.get("datetime") or ""
    loc_obj = info_data.get("location") or {}
    road = loc_obj.get("road") or info_data.get("location_most_frequent_ref") or ""
    city = loc_obj.get("city") or loc_obj.get("state") or ""
    weather = (info_data.get("weather") or {}).get("summary") or ""
    duration = info_data.get("duration_s") or ""
    summary = f"Date: {date} | City/Road: {city} {road} | Weather: {weather} | Duration(s): {duration}"

  print("Uploaded keys:")
  for k in written_keys:
    print(" -", k)

  worker_base = f"https://akys.ai/r2/ready/{slug}"
  print("\nPublic URLs:")
  if info_files:
    print(f" - Info: {worker_base}/dataset_info.json")
  for shot in screenshots:
    print(f" - Screenshot: {worker_base}/screenshots/{shot.name}")

  if summary:
    print("\nSummary:", summary)


if __name__ == "__main__":
  main()
