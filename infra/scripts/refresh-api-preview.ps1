$headers = @{
  "x-dev-role-code" = "system_admin"
  "x-dev-client-id" = "dev-client"
  "x-dev-user-id" = "dev-user"
}

$clientAdminHeaders = @{
  "x-dev-role-code" = "client_admin"
  "x-dev-client-id" = "5c5d9a43-af96-4f17-b0fb-73ae17063e7f"
  "x-dev-user-id" = "f63d8005-be9b-4c52-83d9-1c19dcb55611"
}

$snapshot = @{
  generatedAt = (Get-Date).ToString("o")
  acknowledgements = Invoke-RestMethod "http://127.0.0.1:3001/api/acknowledgements" -Headers $headers
  ai = Invoke-RestMethod "http://127.0.0.1:3001/api/ai/ask" -Headers $clientAdminHeaders -Method Post -Body (@{ question = "barista onboarding rules" } | ConvertTo-Json) -ContentType "application/json"
  health = Invoke-RestMethod "http://127.0.0.1:3001/api/health"
  auth = Invoke-RestMethod "http://127.0.0.1:3001/api/auth/meta" -Headers $headers
  clients = Invoke-RestMethod "http://127.0.0.1:3001/api/clients" -Headers $headers
  clientFeatures = Invoke-RestMethod "http://127.0.0.1:3001/api/clients/features?clientId=5c5d9a43-af96-4f17-b0fb-73ae17063e7f" -Headers $headers
  users = Invoke-RestMethod "http://127.0.0.1:3001/api/users" -Headers $headers
  courses = Invoke-RestMethod "http://127.0.0.1:3001/api/courses" -Headers $headers
  deadlines = Invoke-RestMethod "http://127.0.0.1:3001/api/deadlines" -Headers $headers
  notifications = Invoke-RestMethod "http://127.0.0.1:3001/api/notifications" -Headers $headers
  tests = Invoke-RestMethod "http://127.0.0.1:3001/api/tests" -Headers $headers
  progress = Invoke-RestMethod "http://127.0.0.1:3001/api/progress" -Headers $headers
  adminOps = Invoke-RestMethod "http://127.0.0.1:3001/api/admin-ops/audit-recent?limit=5" -Headers $clientAdminHeaders
  exports = @{
    meta = Invoke-RestMethod "http://127.0.0.1:3001/api/exports/meta"
    clientSnapshot = Invoke-RestMethod "http://127.0.0.1:3001/api/exports/client-snapshot?clientId=5c5d9a43-af96-4f17-b0fb-73ae17063e7f" -Headers $clientAdminHeaders
  }
}

$json = $snapshot | ConvertTo-Json -Depth 10
$content = "window.__API_PREVIEW__ = $json;"

Set-Content -LiteralPath "C:\Users\KROLL\Desktop\LMS Core\docs\api-preview-data.js" -Value $content -Encoding UTF8
