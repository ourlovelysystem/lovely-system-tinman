import json
import os
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
S3 = boto3.client("s3")
BUCKET = os.environ["RECORDINGS_BUCKET"]
ALLOWED_TYPES = {"appeal", "message"}
ALLOWED_CONTENT_TYPES = {"audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg", "audio/wav"}


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "access-control-allow-origin": "*"},
        "body": json.dumps(body),
    }


def body_json(event):
    try:
        return json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return None


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def init_recording(data):
    self_id = str(data.get("self_id", "")).strip()
    message_type = str(data.get("message_type", "appeal")).lower()
    content_type = str(data.get("content_type", "audio/webm")).lower()
    try:
        duration = max(0, min(7200, float(data.get("duration_seconds", 0))))
    except (TypeError, ValueError):
        duration = 0
    if not self_id or len(self_id) > 80:
        return response(400, {"error": "self_id must contain 1–80 characters"})
    if message_type not in ALLOWED_TYPES:
        return response(400, {"error": "unsupported message_type"})
    if content_type not in ALLOWED_CONTENT_TYPES:
        return response(400, {"error": "unsupported audio content type"})

    recording_id = str(uuid.uuid4())
    created_at = now_iso()
    object_key = f"recordings/{message_type}/{recording_id}"
    item = {
        "pk": f"TYPE#{message_type}", "sk": f"{created_at}#{recording_id}",
        "recording_id": recording_id, "self_id": self_id, "message_type": message_type,
        "content_type": content_type, "duration_seconds": Decimal(str(duration)),
        "created_at": created_at, "object_key": object_key, "status": "pending",
    }
    TABLE.put_item(Item=item)
    upload_url = S3.generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET, "Key": object_key, "ContentType": content_type},
        ExpiresIn=300,
    )
    return response(201, {"recording_id": recording_id, "upload_url": upload_url, "expires_in": 300})


def find_recording(recording_id):
    result = TABLE.scan(
        FilterExpression="recording_id = :rid",
        ExpressionAttributeValues={":rid": recording_id},
        Limit=20,
    )
    return next(iter(result.get("Items", [])), None)


def complete_recording(data):
    recording_id = str(data.get("recording_id", ""))
    item = find_recording(recording_id)
    if not item:
        return response(404, {"error": "recording not found"})
    try:
        head = S3.head_object(Bucket=BUCKET, Key=item["object_key"])
    except S3.exceptions.ClientError:
        return response(409, {"error": "audio upload is not present"})
    if head.get("ContentLength", 0) <= 0:
        return response(409, {"error": "audio upload is empty"})
    TABLE.update_item(
        Key={"pk": item["pk"], "sk": item["sk"]},
        UpdateExpression="SET #status=:complete, completed_at=:completed, byte_size=:size",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":complete": "complete", ":completed": now_iso(), ":size": head["ContentLength"]},
    )
    return response(200, {"recording_id": recording_id, "status": "complete"})


def list_recordings(event):
    params = event.get("queryStringParameters") or {}
    message_type = str(params.get("message_type", "appeal")).lower()
    if message_type not in ALLOWED_TYPES:
        return response(400, {"error": "unsupported message_type"})
    try:
        limit = min(100, max(1, int(params.get("limit", 50))))
    except ValueError:
        limit = 50
    result = TABLE.query(
        KeyConditionExpression=Key("pk").eq(f"TYPE#{message_type}"),
        ScanIndexForward=False,
        Limit=limit * 2,
    )
    items = []
    for item in result.get("Items", []):
        if item.get("status") != "complete":
            continue
        play_url = S3.generate_presigned_url("get_object", Params={"Bucket": BUCKET, "Key": item["object_key"]}, ExpiresIn=3600)
        items.append({
            "recording_id": item["recording_id"], "self_id": item["self_id"],
            "message_type": item["message_type"], "duration_seconds": float(item.get("duration_seconds", 0)),
            "created_at": item["created_at"], "play_url": play_url,
        })
        if len(items) == limit:
            break
    return response(200, {"items": items})


def handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}).get("method") or "").upper()
    path = event.get("rawPath", "")
    if method == "POST" and path == "/recordings/init":
        data = body_json(event)
        return response(400, {"error": "invalid JSON"}) if data is None else init_recording(data)
    if method == "POST" and path == "/recordings/complete":
        data = body_json(event)
        return response(400, {"error": "invalid JSON"}) if data is None else complete_recording(data)
    if method == "GET" and path == "/recordings":
        return list_recordings(event)
    if method == "GET" and path == "/health":
        return response(200, {"status": "ok", "server_time": int(time.time())})
    return response(404, {"error": "not found"})
