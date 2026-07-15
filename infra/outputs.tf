output "notes_table" {
  value = aws_dynamodb_table.notes.name
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.bucket
}

output "events_queue_name" {
  value = aws_sqs_queue.events.name
}

output "notifications_topic_arn" {
  value = aws_sns_topic.notifications.arn
}

output "event_bus_name" {
  value = aws_cloudwatch_event_bus.notes.name
}

output "state_machine_arn" {
  value = aws_sfn_state_machine.notes.arn
}

output "secret_arn" {
  value = aws_secretsmanager_secret.application.arn
}

output "parameter_name" {
  value = aws_ssm_parameter.feature.name
}

output "api_id" {
  value = aws_apigatewayv2_api.notes.id
}

output "lambda_name" {
  value = aws_lambda_function.notes.function_name
}

output "lambda_role_name" {
  value = aws_iam_role.lambda.name
}
