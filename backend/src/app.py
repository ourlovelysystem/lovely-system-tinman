import json
import os
import random
import time
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
MAX_RUST = int(os.environ.get("MAX_RUST", "20"))
STATE_KEY = {"pk": "STATE", "sk": "STATE"}
ALLOWED_TARGETS = {"tinman", "interface-hinge", "interface-panel"}


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "access-control-allow-origin": "*"},
        "body": json.dumps(body),
    }


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def state():
    item = TABLE.get_item(Key=STATE_KEY, ConsistentRead=True).get("Item")
    if not item:
        TABLE.put_item(Item={**STATE_KEY, "rust_points": MAX_RUST, "last_daily_roll": ""}, ConditionExpression="attribute_not_exists(pk)")
        item = TABLE.get_item(Key=STATE_KEY, ConsistentRead=True)["Item"]
    return {"rust_points": int(item.get("rust_points", MAX_RUST)), "max_rust": MAX_RUST, "last_daily_roll": item.get("last_daily_roll", ""), "server_time": int(time.time())}


def oil(body):
    self_id = str(body.get("self_id", "")).strip()
    target = str(body.get("target", ""))
    if not self_id or len(self_id) > 80:
        return response(400, {"error": "self_id must contain 1–80 characters"})
    if target not in ALLOWED_TARGETS:
        return response(400, {"error": "unknown oil target"})

    event_id = f"{int(time.time() * 1000):013d}#{uuid.uuid4()}"
    created = now_iso()
    try:
        TABLE.meta.client.transact_write_items(TransactItems=[
            {"Update": {
                "TableName": TABLE.name,
                "Key": {"pk": {"S": "STATE"}, "sk": {"S": "STATE"}},
                "UpdateExpression": "SET rust_points = rust_points - :one",
                "ConditionExpression": "attribute_exists(pk) AND rust_points > :zero",
                "ExpressionAttributeValues": {":one": {"N": "1"}, ":zero": {"N": "0"}},
            }},
            {"Put": {
                "TableName": TABLE.name,
                "Item": {
                    "pk": {"S": "LOG"}, "sk": {"S": event_id}, "self_id": {"S": self_id},
                    "target": {"S": target}, "squirts": {"N": "1"}, "created_at": {"S": created},
                },
            }},
        ])
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "TransactionCanceledException":
            return response(409, {**state(), "error": "Tinman is already fully restored"})
        raise
    return response(200, state())


def maintenance(event):
    raw = (event.get("queryStringParameters") or {}).get("limit", "40")
    try:
        limit = min(100, max(1, int(raw)))
    except ValueError:
        limit = 40
    result = TABLE.query(KeyConditionExpression=Key("pk").eq("LOG"), ScanIndexForward=False, Limit=limit)
    items = [{"self_id": x["self_id"], "target": x["target"], "squirts": int(x.get("squirts", 1)), "created_at": x["created_at"]} for x in result.get("Items", [])]
    return response(200, {"items": items})


def daily_rust():
    today = datetime.now(timezone.utc).date().isoformat()
    points = random.randint(0, 3)
    current = state()
    if current["last_daily_roll"] == today:
        return {"event": "daily-rust", "already_applied": True, **current}
    new_rust = min(MAX_RUST, current["rust_points"] + points)
    try:
        TABLE.update_item(
            Key=STATE_KEY,
            UpdateExpression="SET rust_points=:rust, last_daily_roll=:today",
            ConditionExpression="attribute_not_exists(last_daily_roll) OR last_daily_roll <> :today",
            ExpressionAttributeValues={":rust": new_rust, ":today": today},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    return {"event": "daily-rust", "added": points, **state()}


def handler(event, context):
    if event.get("source") == "tinman.lifecycle":
        return daily_rust()
    method = (event.get("requestContext", {}).get("http", {}).get("method") or "").upper()
    path = event.get("rawPath", "")
    if method == "GET" and path == "/state":
        return response(200, state())
    if method == "GET" and path == "/maintenance":
        return maintenance(event)
    if method == "POST" and path == "/oil":
        try:
            body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return response(400, {"error": "invalid JSON"})
        return oil(body)
    return response(404, {"error": "not found"})
