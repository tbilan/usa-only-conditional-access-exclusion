<#
 Approves this app in a CUSTOMER tenant when you manage that tenant through GDAP (partner delegated admin).

 Why: the normal "Grant admin consent" link fails for partner admins with AADSTS90099
 ("Applications must be authorized to access the customer tenant before partner delegated administrators can use them").
 This script does the same thing the consent page would do, through Microsoft Graph:
   1. creates the app's service principal (enterprise application) in the customer tenant, and
   2. grants it the Microsoft Graph application permissions the app needs.

 Your GDAP relationship with the customer must include roles that allow this, e.g. Cloud Application Administrator
 (create the enterprise app) and Privileged Role Administrator (grant Graph application permissions), or Global Administrator.

 Example:
   .\infra\grant-tenant-consent.ps1 -TenantId fa62bef9-9beb-45ed-9042-b4538d99a033 -ClientId 9d1f8414-70ba-4b0c-b3b2-79bf0a301ce6
#>
param(
  [Parameter(Mandatory)][string]$TenantId,   # the CUSTOMER tenant ID
  [Parameter(Mandatory)][string]$ClientId,   # this app's Application (client) ID
  [string[]]$Permissions = @(
    'Policy.ReadWrite.ConditionalAccess',
    'Policy.Read.All',
    'Application.Read.All',
    'User.Read.All',
    'AuditLog.Read.All'
  )
)
$ErrorActionPreference = 'Stop'
$GraphAppId = '00000003-0000-0000-c000-000000000000' # Microsoft Graph

Write-Host "Signing in to customer tenant $TenantId (use your bilan.com partner account)..."
az login --tenant $TenantId --allow-no-subscriptions --output none
if ($LASTEXITCODE -ne 0) { throw 'Sign-in to the customer tenant failed.' }

$signedIn = az account show --query tenantId -o tsv
if ($signedIn -ne $TenantId) { throw "Signed in to tenant $signedIn, not $TenantId. Stopping." }

# 1. The app's service principal in the customer tenant.
$sp = az ad sp show --id $ClientId -o json 2>$null | ConvertFrom-Json
if (-not $sp) {
  Write-Host 'Creating the enterprise application (service principal) in the customer tenant...'
  $sp = az ad sp create --id $ClientId -o json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $sp) { throw 'Could not create the service principal. Does your GDAP access include Cloud Application Administrator?' }
} else {
  Write-Host 'The enterprise application already exists in the customer tenant.'
}

# 2. Microsoft Graph's service principal there, and the IDs of the permissions we need.
$graph = az ad sp show --id $GraphAppId -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $graph) { throw 'Could not read the Microsoft Graph service principal.' }

$bodyFile = Join-Path $env:TEMP 'caex-approle.json'
$failed = @()
foreach ($name in $Permissions) {
  $role = $graph.appRoles | Where-Object { $_.value -eq $name -and $_.allowedMemberTypes -contains 'Application' }
  if (-not $role) { Write-Warning "Permission $name not found on Microsoft Graph; skipped."; $failed += $name; continue }

  @{ principalId = $sp.id; resourceId = $graph.id; appRoleId = $role.id } | ConvertTo-Json | Set-Content -Path $bodyFile -Encoding ascii
  $result = az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignments" `
              --headers 'Content-Type=application/json' --body "@$bodyFile" 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  granted         $name"
  } elseif ("$result" -match 'already exists') {
    Write-Host "  already granted $name"
  } else {
    Write-Warning "  FAILED          $name : $result"
    $failed += $name
  }
}
Remove-Item $bodyFile -ErrorAction SilentlyContinue

Write-Host ''
if ($failed.Count) {
  throw "Some permissions were not granted: $($failed -join ', '). Granting Graph application permissions needs Privileged Role Administrator or Global Administrator in your GDAP relationship."
}
Write-Host "Done. In the app, open this tenant and press 'Check again'."
Write-Host 'Note: you are now signed in to the customer tenant in the az CLI. Switch back with: az login --tenant <your tenant id>'
