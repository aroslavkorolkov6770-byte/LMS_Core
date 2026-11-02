$packageId = "PostgreSQL.PostgreSQL.17"

Write-Host "Installing PostgreSQL via winget..."
winget install --id $packageId --exact --accept-package-agreements --accept-source-agreements
