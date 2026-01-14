# AKYS R2 Dataset Uploader

## Required environment variables

```bash
export R2_ACCOUNT_ID="..."
export R2_ACCESS_KEY_ID="..."
export R2_SECRET_ACCESS_KEY="..."
export R2_BUCKET_DATASETS="road-horizon-datasets"
```

## Upload a dataset bundle

```bash
python scripts/akys_dataset_uploader.py "/path/to/local_dataset_folder"
```

The folder should contain exactly one `.zip`, dataset_info_front.json and/or dataset_info_rear.json, and screenshot_* files. The script uploads metadata/screenshots to `ready/<slug>/...` and the zip to `private/<slug>.zip` in the R2 bucket. Public URLs are served via the Worker at `https://akys.ai/r2/ready/<slug>/...`.
