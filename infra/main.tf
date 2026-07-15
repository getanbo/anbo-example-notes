locals {
  name = var.project_name
  tags = {
    Project   = var.project_name
    ManagedBy = "anbo"
  }
}

resource "aws_dynamodb_table" "notes" {
  name             = "${local.name}-notes"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "id"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "id"
    type = "S"
  }

  tags = local.tags
}

resource "aws_s3_bucket" "attachments" {
  bucket = "${local.name}-attachments"
  tags   = local.tags
}

resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_sqs_queue" "events" {
  name                       = "${local.name}-events"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 3600
  tags                       = local.tags
}

resource "aws_sns_topic" "notifications" {
  name = "${local.name}-notifications"
  tags = local.tags
}

resource "aws_sns_topic_subscription" "events" {
  topic_arn = aws_sns_topic.notifications.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.events.arn
}

resource "aws_cloudwatch_event_bus" "notes" {
  name = "${local.name}-bus"
  tags = local.tags
}

resource "aws_cloudwatch_event_rule" "note_created" {
  name           = "${local.name}-created"
  event_bus_name = aws_cloudwatch_event_bus.notes.name
  event_pattern = jsonencode({
    source      = ["anbo.notes"]
    detail-type = ["NoteCreated"]
  })
  tags = local.tags
}

resource "aws_cloudwatch_event_target" "events_queue" {
  rule           = aws_cloudwatch_event_rule.note_created.name
  event_bus_name = aws_cloudwatch_event_bus.notes.name
  arn            = aws_sqs_queue.events.arn
}

data "aws_iam_policy_document" "queue" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.events.arn]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com", "events.amazonaws.com"]
    }
  }
}

resource "aws_sqs_queue_policy" "events" {
  queue_url = aws_sqs_queue.events.url
  policy    = data.aws_iam_policy_document.queue.json
}

resource "aws_secretsmanager_secret" "application" {
  name = "${local.name}/application"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "application" {
  secret_id     = aws_secretsmanager_secret.application.id
  secret_string = jsonencode({ application = "notes-demo", mode = "local" })
}

resource "aws_ssm_parameter" "feature" {
  name  = "/${local.name}/features/workflows"
  type  = "String"
  value = "enabled"
  tags  = local.tags
}

resource "aws_cloudwatch_log_group" "notes" {
  name              = "/anbo/notes"
  retention_in_days = 7
  tags              = local.tags
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "lambda" {
  name = "${local.name}-lambda"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:*", "logs:*", "s3:*", "sqs:*", "sns:*", "events:*"]
      Resource = "*"
    }]
  })
}

resource "aws_lambda_function" "notes" {
  function_name    = "${local.name}-handler"
  role             = aws_iam_role.lambda.arn
  runtime          = "python3.12"
  handler          = "handler.handler"
  filename         = "${path.module}/dist/notes-lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/notes-lambda.zip")
  timeout          = 20

  environment {
    variables = {
      NOTES_TABLE        = aws_dynamodb_table.notes.name
      ATTACHMENTS_BUCKET = aws_s3_bucket.attachments.bucket
    }
  }

  tags = local.tags
}

resource "aws_lambda_event_source_mapping" "notes_stream" {
  event_source_arn  = aws_dynamodb_table.notes.stream_arn
  function_name     = aws_lambda_function.notes.arn
  starting_position = "LATEST"
  batch_size        = 10
}

resource "aws_apigatewayv2_api" "notes" {
  name          = "${local.name}-http"
  protocol_type = "HTTP"
  tags          = local.tags
}

resource "aws_apigatewayv2_integration" "notes" {
  api_id                 = aws_apigatewayv2_api.notes.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.notes.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.notes.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.notes.id}"
}

resource "aws_apigatewayv2_route" "notes" {
  api_id    = aws_apigatewayv2_api.notes.id
  route_key = "ANY /notes/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.notes.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.notes.id
  name        = "$default"
  auto_deploy = true
  tags        = local.tags
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notes.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.notes.execution_arn}/*/*"
}

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${local.name}-sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "sfn" {
  name = "${local.name}-sfn"
  role = aws_iam_role.sfn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = aws_lambda_function.notes.arn
    }]
  })
}

resource "aws_sfn_state_machine" "notes" {
  name     = "${local.name}-workflow"
  role_arn = aws_iam_role.sfn.arn
  definition = jsonencode({
    StartAt = "ProcessNote"
    States = {
      ProcessNote = {
        Type     = "Task"
        Resource = aws_lambda_function.notes.arn
        End      = true
      }
    }
  })
  tags = local.tags
}
