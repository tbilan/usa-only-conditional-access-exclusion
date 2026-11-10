<#
 Deploys USA-only Conditional Access Exclusion to Azure App Service in your bilan.com subscription.
 Prereqs: Azure CLI (az), git, and `az login` as someone who can create resources and role assignments
 (Owner, or Contributor + User Access Administrator) in the target subscription.

 Example:
   .\infra\deploy.ps1 -AppName bilan-usa-only-ca -ClientId <app id> -PartnerTenantId <bilan.com tenant id>
#>
param(
  [Parameter(Mandatory)][string]$AppName,
  [Parameter(Mandatory)][string]$ClientId,
  [Parameter(Mandatory)][string]$PartnerTenantId,
  [string]$ResourceGroup = 'rg-usa-only-ca',
  [string]$Location = 'eastus2',
  [string]$Sku = 'B1'
)
$ErrorActionPreference = 'Stop'

$secure = Read-Host 'App registration client secret VALUE' -AsSecureString
$secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

# Keep the secret out of the command line: pass parameters through a temp file.
$paramFile = Join-Path $env:TEMP 'caex-params.json'
@{
  '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
  contentVersion = '1.0.0.0'
  parameters = @{
    appName = @{ value = $AppName }
    clientId = @{ value = $ClientId }
    partnerTenantId = @{ value = $PartnerTenantId }
    sku = @{ value = $Sku }
    location = @{ value = $Location }
    clientSecret = @{ value = $secret }
  }
} | ConvertTo-Json -Depth 5 | Set-Content -Path $paramFile -Encoding utf8

try {
  if ((az group exists -n $ResourceGroup) -ne 'true') {
    Write-Host "Creating resource group $ResourceGroup..."
    az group create -n $ResourceGroup -l $Location | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the resource group.' }
  }

  Write-Host 'Deploying infrastructure (plan, web app, Key Vault)...'
  $out = az deployment group create -g $ResourceGroup -f "$PSScriptRoot/main.bicep" -p "@$paramFile" `
           --query properties.outputs -o json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $out) {
    throw "Infrastructure deployment failed (see the error above). If it says 'Current Limit (B1 VMs): 0', your subscription has no App Service quota in ${Location}: try -Location with another region, or a different -Sku, or request quota."
  }
} finally {
  Remove-Item $paramFile -ErrorAction SilentlyContinue
}

Write-Host 'Packaging committed source (excludes .env, data and node_modules)...'
$zip = Join-Path $env:TEMP 'caex.zip'
Remove-Item $zip -ErrorAction SilentlyContinue
git -C "$PSScriptRoot/.." archive --format=zip -o $zip HEAD

Write-Host 'Deploying code (App Service runs npm install)...'
az webapp deploy -g $ResourceGroup -n $AppName --src-path $zip --type zip
if ($LASTEXITCODE -ne 0) { throw 'Code deployment failed.' }

Write-Host ''
Write-Host "Site: $($out.siteUrl.value)"
Write-Host 'NEXT: on the app registration > Authentication, add these Web redirect URIs:'
Write-Host "  $($out.signInRedirectUri.value)"
Write-Host "  $($out.consentRedirectUri.value)"
