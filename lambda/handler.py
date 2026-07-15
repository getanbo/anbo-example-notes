import json
import os

import boto3


def handler(event, context):
    if "Records" in event:
        return {"processed": len(event["Records"]), "source": "dynamodb-stream"}

    operation = event.get("operation")
    if operation == "workflow":
        return {"ok": True, "note_id": event.get("note", {}).get("id")}

    path = event.get("rawPath") or event.get("path") or "/"
    if path == "/health":
        return response(200, {"ok": True, "service": "notes-lambda"})
    if path.startswith("/notes/"):
        note_id = path.rsplit("/", 1)[-1]
        dynamodb = boto3.resource(
            "dynamodb",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )
        item = dynamodb.Table(os.environ["NOTES_TABLE"]).get_item(Key={"id": note_id}).get("Item")
        return response(200 if item else 404, item or {"error": "note_not_found"})
    return response(404, {"error": "not_found", "path": path})


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }
