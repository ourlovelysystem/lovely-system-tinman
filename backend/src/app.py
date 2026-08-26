import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
S3 = boto3.client("s3")
TRANSCRIBE = boto3.client("transcribe")
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
    title = str(data.get("title", "")).strip()
    message_type = str(data.get("message_type", "appeal")).lower()
    content_type = str(data.get("content_type", "audio/webm")).lower()
    try:
        duration = max(0, min(7200, float(data.get("duration_seconds", 0))))
    except (TypeError, ValueError):
        duration = 0
    if not self_id or len(self_id) > 80:
        return response(400, {"error": "self_id must contain 1–80 characters"})
    if len(title) > 120:
        return response(400, {"error": "title must not exceed 120 characters"})
    if message_type not in ALLOWED_TYPES:
        return response(400, {"error": "unsupported message_type"})
    if content_type not in ALLOWED_CONTENT_TYPES:
        return response(400, {"error": "unsupported audio content type"})

    recording_id = str(uuid.uuid4())
    created_at = now_iso()
    object_key = f"recordings/{message_type}/{recording_id}"
    item = {
        "pk": f"TYPE#{message_type}", "sk": f"{created_at}#{recording_id}",
        "recording_id": recording_id, "self_id": self_id, "title": title, "message_type": message_type,
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
            "recording_id": item["recording_id"], "self_id": item["self_id"], "title": item.get("title", ""),
            "message_type": item["message_type"], "duration_seconds": float(item.get("duration_seconds", 0)),
            "created_at": item["created_at"], "play_url": play_url,
        })
        if len(items) == limit:
            break
    return response(200, {"items": items})



def init_response(data):
    recording_id = str(data.get("recording_id", "")).strip()
    self_id = str(data.get("self_id", "")).strip()
    original = find_recording(recording_id)
    if not original or original.get("status") != "complete":
        return response(404, {"error": "original recording not found"})
    if not self_id or len(self_id) > 80:
        return response(400, {"error": "self_id must contain 1–80 characters"})
    try:
        duration = max(0, min(7200, float(data.get("duration_seconds", 0))))
        incoming = data.get("segments", [])
        if not 1 <= len(incoming) <= 100:
            raise ValueError()
        segments = []
        for index, segment in enumerate(incoming):
            content_type = str(segment.get("content_type", "audio/webm")).lower()
            if content_type not in ALLOWED_CONTENT_TYPES:
                return response(400, {"error": "unsupported audio content type"})
            segments.append({
                "index": index,
                "anchor_seconds": max(0, float(segment.get("anchor_seconds", 0))),
                "duration_seconds": max(0, float(segment.get("duration_seconds", 0))),
                "content_type": content_type,
            })
    except (TypeError, ValueError):
        return response(400, {"error": "invalid response segments"})

    response_id = str(uuid.uuid4())
    created_at = now_iso()
    public_segments = []
    stored_segments = []
    for segment in segments:
        object_key = f"responses/{recording_id}/{response_id}/{segment['index']}"
        upload_url = S3.generate_presigned_url(
            "put_object",
            Params={"Bucket": BUCKET, "Key": object_key, "ContentType": segment["content_type"]},
            ExpiresIn=300,
        )
        public_segments.append({"index": segment["index"], "upload_url": upload_url})
        stored_segments.append({
            **segment,
            "anchor_seconds": Decimal(str(segment["anchor_seconds"])),
            "duration_seconds": Decimal(str(segment["duration_seconds"])),
            "object_key": object_key,
        })
    item = {
        "pk": f"RECORDING#{recording_id}", "sk": f"{created_at}#{response_id}",
        "response_id": response_id, "recording_id": recording_id, "self_id": self_id,
        "duration_seconds": Decimal(str(duration)),
        "original_duration_seconds": original.get("duration_seconds", Decimal("0")),
        "segments": stored_segments, "created_at": created_at, "status": "pending",
    }
    TABLE.put_item(Item=item)
    return response(201, {"response_id": response_id, "segments": public_segments, "expires_in": 300})


def find_response(recording_id, response_id):
    result = TABLE.query(
        KeyConditionExpression=Key("pk").eq(f"RECORDING#{recording_id}"),
        FilterExpression="response_id = :rid",
        ExpressionAttributeValues={":rid": response_id},
        Limit=100,
    )
    return next(iter(result.get("Items", [])), None)


def complete_response(data):
    recording_id = str(data.get("recording_id", "")).strip()
    response_id = str(data.get("response_id", "")).strip()
    item = find_response(recording_id, response_id)
    if not item:
        return response(404, {"error": "response not found"})
    total_size = 0
    try:
        for segment in item.get("segments", []):
            head = S3.head_object(Bucket=BUCKET, Key=segment["object_key"])
            if head.get("ContentLength", 0) <= 0:
                return response(409, {"error": "response audio insertion is empty"})
            total_size += head["ContentLength"]
    except S3.exceptions.ClientError:
        return response(409, {"error": "response audio insertion is not present"})
    ack_jobs = start_acknowledgment_jobs(item)
    TABLE.update_item(
        Key={"pk": item["pk"], "sk": item["sk"]},
        UpdateExpression="SET #status=:complete, completed_at=:completed, byte_size=:size, ack_status=:ack, ack_jobs=:jobs",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":complete": "complete", ":completed": now_iso(), ":size": total_size,
            ":ack": "processing", ":jobs": ack_jobs,
        },
    )
    return response(200, {"response_id": response_id, "status": "complete", "ack_status": "processing"})


def list_responses(event):
    params = event.get("queryStringParameters") or {}
    recording_id = str(params.get("recording_id", "")).strip()
    if not recording_id:
        return response(400, {"error": "recording_id is required"})
    result = TABLE.query(
        KeyConditionExpression=Key("pk").eq(f"RECORDING#{recording_id}"),
        ScanIndexForward=True,
        Limit=100,
    )
    items = []
    for item in result.get("Items", []):
        if item.get("status") != "complete":
            continue
        segments = []
        for segment in item.get("segments", []):
            play_url = S3.generate_presigned_url("get_object", Params={"Bucket": BUCKET, "Key": segment["object_key"]}, ExpiresIn=3600)
            segments.append({
                "index": int(segment["index"]),
                "anchor_seconds": float(segment["anchor_seconds"]),
                "duration_seconds": float(segment["duration_seconds"]),
                "play_url": play_url,
            })
        declaration = resolve_acknowledgment(item)
        duration = float(item.get("duration_seconds", 0))
        original_duration = float(item.get("original_duration_seconds", 0))
        items.append({
            "response_id": item["response_id"], "recording_id": recording_id,
            "self_id": item["self_id"], "duration_seconds": duration,
            "segments": segments, "created_at": item["created_at"],
            "is_short": duration <= original_duration,
            "speaks_for_our_lovely_system": declaration["qualifies"],
            "ack_status": declaration["status"],
        })
    return response(200, {"items": items})



def response_items(recording_id):
    result = TABLE.query(
        KeyConditionExpression=Key("pk").eq(f"RECORDING#{recording_id}"),
        ScanIndexForward=True,
        Limit=100,
    )
    return [item for item in result.get("Items", []) if item.get("status") == "complete" and item.get("response_id")]


def transcript_signature(recording_id, replies):
    return "|".join(["ack-v2", recording_id] + [
        f"{item['response_id']}:{len(item.get('segments', []))}" for item in replies
    ])


def latest_transcript(recording_id):
    result = TABLE.query(
        KeyConditionExpression=Key("pk").eq(f"TRANSCRIPT#{recording_id}"),
        ScanIndexForward=False,
        Limit=1,
    )
    return next(iter(result.get("Items", [])), None)


def media_format(content_type):
    base = str(content_type or "audio/webm").split(";", 1)[0]
    return {
        "audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg", "audio/wav": "wav",
    }.get(base, "webm")


def start_transcript_job(recording_id, request_id, role, object_key, content_type, speaker, anchor_seconds=None, response_id=None):
    job_name = f"tinman-{recording_id[:8]}-{uuid.uuid4().hex[:16]}"
    output_key = f"transcripts/{recording_id}/{request_id}/{job_name}.json"
    TRANSCRIBE.start_transcription_job(
        TranscriptionJobName=job_name,
        Media={"MediaFileUri": f"s3://{BUCKET}/{object_key}"},
        MediaFormat=media_format(content_type),
        IdentifyLanguage=True,
        OutputBucketName=BUCKET,
        OutputKey=output_key,
    )
    job = {
        "job_name": job_name, "output_key": output_key, "role": role,
        "speaker": speaker, "status": "IN_PROGRESS",
    }
    if anchor_seconds is not None:
        job["anchor_seconds"] = Decimal(str(anchor_seconds))
    if response_id is not None:
        job["response_id"] = response_id
    return job


def unlock_transcript(data):
    recording_id = str(data.get("recording_id", "")).strip()
    original = find_recording(recording_id)
    if not original or original.get("status") != "complete":
        return response(404, {"error": "original recording not found"})
    replies = response_items(recording_id)
    signature = transcript_signature(recording_id, replies)
    existing = latest_transcript(recording_id)
    if existing and existing.get("source_signature") == signature and existing.get("status") in {"processing", "complete"}:
        return response(200, {"recording_id": recording_id, "status": existing["status"]})

    request_id = str(uuid.uuid4())
    jobs = [start_transcript_job(
        recording_id, request_id, "original", original["object_key"], original["content_type"],
        original.get("self_id", "Original"),
    )]
    for reply in replies:
        for segment in reply.get("segments", []):
            jobs.append(start_transcript_job(
                recording_id, request_id, "annotation", segment["object_key"], segment["content_type"],
                reply.get("self_id", "Responder"), float(segment.get("anchor_seconds", 0)), reply["response_id"],
            ))
    created_at = now_iso()
    TABLE.put_item(Item={
        "pk": f"TRANSCRIPT#{recording_id}", "sk": f"{created_at}#{request_id}",
        "recording_id": recording_id, "request_id": request_id, "created_at": created_at,
        "source_signature": signature, "status": "processing", "jobs": jobs,
    })
    return response(202, {"recording_id": recording_id, "status": "processing", "job_count": len(jobs)})


def transcript_payload(output_key):
    raw = S3.get_object(Bucket=BUCKET, Key=output_key)["Body"].read()
    return json.loads(raw)


def transcript_text(payload):
    transcripts = payload.get("results", {}).get("transcripts", [])
    return transcripts[0].get("transcript", "") if transcripts else ""


def original_tokens(payload):
    tokens = []
    last_time = 0.0
    for item in payload.get("results", {}).get("items", []):
        alternatives = item.get("alternatives", [])
        if not alternatives:
            continue
        content = alternatives[0].get("content", "")
        if "start_time" in item:
            last_time = float(item["start_time"])
        tokens.append({"time": last_time, "content": content, "type": item.get("type", "pronunciation")})
    return tokens


def join_tokens(tokens):
    text = ""
    for token in tokens:
        content = token["content"]
        if not text or token["type"] == "punctuation" or content in ".,!?;:%)]}":
            text += content
        else:
            text += " " + content
    return text.strip()


def assemble_transcript(recording_id, jobs):
    original_job = next(job for job in jobs if job["role"] == "original")
    original_payload = transcript_payload(original_job["output_key"])
    tokens = original_tokens(original_payload)
    annotations = []
    for job in jobs:
        if job["role"] != "annotation":
            continue
        annotations.append({
            "speaker": job["speaker"],
            "response_id": job.get("response_id"),
            "anchor_seconds": float(job.get("anchor_seconds", 0)),
            "text": transcript_text(transcript_payload(job["output_key"])),
        })
    annotations.sort(key=lambda item: item["anchor_seconds"])
    parts, cursor = [], 0
    original_speaker = original_job.get("speaker", "Original")
    for annotation in annotations:
        end = cursor
        while end < len(tokens) and tokens[end]["time"] <= annotation["anchor_seconds"]:
            end += 1
        text = join_tokens(tokens[cursor:end])
        if text:
            parts.append({"speaker": original_speaker, "role": "original", "text": text})
        if annotation["text"]:
            parts.append({
                "speaker": annotation["speaker"], "role": "annotation",
                "response_id": annotation.get("response_id"),
                "anchor_seconds": annotation["anchor_seconds"], "text": annotation["text"],
            })
        cursor = end
    tail = join_tokens(tokens[cursor:])
    if tail:
        parts.append({"speaker": original_speaker, "role": "original", "text": tail})
    return parts



ACKNOWLEDGMENT_PATTERN = re.compile(
    r"\bi\s+(?:(?:speak|am\s+speaking)\s+(?:for|on\s+behalf\s+of)|am\s+a\s+speaker\s+for)\s+our\s+lovely\s+system\b",
    re.IGNORECASE,
)


def start_acknowledgment_jobs(item):
    request_id = str(uuid.uuid4())
    return [
        start_transcript_job(
            item["recording_id"], request_id, "acknowledgment",
            segment["object_key"], segment["content_type"], item.get("self_id", "Responder"),
            float(segment.get("anchor_seconds", 0)), item["response_id"],
        )
        for segment in item.get("segments", [])
    ]


def resolve_acknowledgment(item):
    status = item.get("ack_status")
    if status == "complete":
        return {"status": "complete", "qualifies": bool(item.get("speaks_for_our_lovely_system", False))}
    jobs = item.get("ack_jobs", [])
    if not jobs:
        jobs = start_acknowledgment_jobs(item)
        TABLE.update_item(
            Key={"pk": item["pk"], "sk": item["sk"]},
            UpdateExpression="SET ack_status=:status, ack_jobs=:jobs",
            ExpressionAttributeValues={":status": "processing", ":jobs": jobs},
        )
        return {"status": "processing", "qualifies": False}

    states = [
        TRANSCRIBE.get_transcription_job(TranscriptionJobName=job["job_name"])
        ["TranscriptionJob"]["TranscriptionJobStatus"]
        for job in jobs
    ]
    if "FAILED" in states:
        TABLE.update_item(
            Key={"pk": item["pk"], "sk": item["sk"]},
            UpdateExpression="SET ack_status=:status",
            ExpressionAttributeValues={":status": "failed"},
        )
        return {"status": "failed", "qualifies": False}
    if any(state != "COMPLETED" for state in states):
        return {"status": "processing", "qualifies": False}

    text = " ".join(transcript_text(transcript_payload(job["output_key"])) for job in jobs).strip()
    qualifies = bool(ACKNOWLEDGMENT_PATTERN.search(text))
    TABLE.update_item(
        Key={"pk": item["pk"], "sk": item["sk"]},
        UpdateExpression="SET ack_status=:status, speaks_for_our_lovely_system=:qualifies, acknowledgment_text=:text",
        ExpressionAttributeValues={":status": "complete", ":qualifies": qualifies, ":text": text},
    )
    return {"status": "complete", "qualifies": qualifies}


def get_transcript(event):
    params = event.get("queryStringParameters") or {}
    recording_id = str(params.get("recording_id", "")).strip()
    if not recording_id:
        return response(400, {"error": "recording_id is required"})
    item = latest_transcript(recording_id)
    if not item:
        return response(200, {"recording_id": recording_id, "status": "locked"})

    jobs = item.get("jobs", [])
    failed = False
    complete = True
    for job in jobs:
        state = TRANSCRIBE.get_transcription_job(
            TranscriptionJobName=job["job_name"]
        )["TranscriptionJob"]["TranscriptionJobStatus"]
        if state == "FAILED":
            failed = True
        if state != "COMPLETED":
            complete = False
    if failed:
        TABLE.update_item(
            Key={"pk": item["pk"], "sk": item["sk"]},
            UpdateExpression="SET #status=:failed",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":failed": "failed"},
        )
        return response(200, {"recording_id": recording_id, "status": "failed"})
    if not complete:
        return response(200, {"recording_id": recording_id, "status": "processing"})

    parts = assemble_transcript(recording_id, jobs)
    replies = response_items(recording_id)
    stale = item.get("source_signature") != transcript_signature(recording_id, replies)
    TABLE.update_item(
        Key={"pk": item["pk"], "sk": item["sk"]},
        UpdateExpression="SET #status=:complete",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":complete": "complete"},
    )
    return response(200, {
        "recording_id": recording_id, "status": "stale" if stale else "complete",
        "parts": parts, "created_at": item["created_at"],
    })


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
    if method == "POST" and path == "/responses/init":
        data = body_json(event)
        return response(400, {"error": "invalid JSON"}) if data is None else init_response(data)
    if method == "POST" and path == "/responses/complete":
        data = body_json(event)
        return response(400, {"error": "invalid JSON"}) if data is None else complete_response(data)
    if method == "GET" and path == "/responses":
        return list_responses(event)
    if method == "POST" and path == "/transcripts/unlock":
        data = body_json(event)
        return response(400, {"error": "invalid JSON"}) if data is None else unlock_transcript(data)
    if method == "GET" and path == "/transcripts":
        return get_transcript(event)
    if method == "GET" and path == "/health":
        return response(200, {"status": "ok", "server_time": int(time.time())})
    return response(404, {"error": "not found"})
