<#
 One-time setup for CI/CD to Azure Container Apps. Run it yourself, signed in (az login) as an Owner of the
 subscription. It creates NO app resources; the GitHub workflow does that on the next push to main.

 What it does:
   1. Registers the Azure resource providers the deployment needs.
   2. Creates the resource group (if missing) and a managed identity "id-github-deploy" that GitHub Actions
      signs in as (OIDC federation: no password is stored anywhere), with Contributor on that resource group only.
   3. Sets the GitHub repository variables/secret the workflow reads (uses the gh CLI if installed, else prints them).

 Example:
   .\infra\setup-cicd.ps1 -AppName usa-only-exclusion-tool -ClientId <app id> -PartnerTenantId <bilan.com tenant id> -Location centralus
#>
param(
  [Parameter(Mandatory)][string]$AppName,
  [Parameter(Mandatory)][string]$ClientId,
  [Parameter(Mandatory)][string]$PartnerTenantId,
  [string]$ResourceGroup = 'rg-usa-only-ca',
  [string]$Location = 'eastus2',
  [string]$TimeZone = 'America/New_York',
  [string]$Repo = 'tbilan/usa-only-conditional-access-exclusion',
  [string]$Branch = 'main'
)
$ErrorActionPreference = 'Stop'
function Check([string]$what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (see the error above)." } }

$AppName = $AppName.ToLower()
if ($AppName -notmatch '^[a-z][a-z0-9-]{0,30}[a-z0-9]$') { throw 'AppName must be lower-case letters, digits and hyphens (max 32), starting with a letter.' }

$sub = az account show --query id -o tsv; Check 'az account show (are you signed in? run az login)'
$tenant = az account show --query tenantId -o tsv

Write-Host 'Registering resource providers (can take a few minutes the first time)...'
foreach ($ns in 'Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.Storage', 'Microsoft.ManagedIdentity') {
  az provider register -n $ns --wait; Check "Registering $ns"
}

if ((az group exists -n $ResourceGroup) -ne 'true') {
  az group create -n $ResourceGroup -l $Location | Out-Null; Check 'Creating the resource group'
}
$scope = "/subscriptions/$sub/resourceGroups/$ResourceGroup"

Write-Host 'Creating the deployment identity for GitHub Actions...'
$id = az identity create -g $ResourceGroup -n id-github-deploy -l $Location -o json | ConvertFrom-Json; Check 'Creating the identity'

$assigned = $false
foreach ($try in 1..6) { # a new identity can take a moment to become assignable
  az role assignment create --assignee-object-id $id.principalId --assignee-principal-type ServicePrincipal --role Contributor --scope $scope | Out-Null
  if ($LASTEXITCODE -eq 0) { $assigned = $true; break }
  Start-Sleep -Seconds 10
}
if (-not $assigned) { throw 'Could not grant Contributor to the deployment identity.' }

# GitHub identifies the repository to Azure by name ("repo:owner/name:...") or, on newer repositories, by
# immutable IDs ("repo:owner@<id>/name@<id>:..."). Register both so sign-in works either way.
$subjects = [ordered]@{ 'github-main' = "repo:${Repo}:ref:refs/heads/${Branch}" }
if (Get-Command gh -ErrorAction SilentlyContinue) {
  $info = gh api "repos/$Repo" | ConvertFrom-Json
  if ($LASTEXITCODE -eq 0 -and $info.id) {
    $owner, $name = $Repo.Split('/')
    $subjects['github-main-ids'] = "repo:${owner}@$($info.owner.id)/${name}@$($info.id):ref:refs/heads/${Branch}"
  }
}
foreach ($k in $subjects.Keys) {
  az identity federated-credential create -g $ResourceGroup --identity-name id-github-deploy -n $k `
    --issuer https://token.actions.githubusercontent.com --subject $subjects[$k] `
    --audiences api://AzureADTokenExchange | Out-Null; Check "Creating the GitHub federation ($k)"
}

$vars = [ordered]@{
  AZURE_CLIENT_ID       = $id.clientId
  AZURE_TENANT_ID       = $tenant
  AZURE_SUBSCRIPTION_ID = $sub
  AZURE_RESOURCE_GROUP  = $ResourceGroup
  AZURE_LOCATION        = $Location
  APP_NAME              = $AppName
  APP_CLIENT_ID         = $ClientId
  PARTNER_TENANT_ID     = $PartnerTenantId
  APP_TIMEZONE          = $TimeZone
}

if (Get-Command gh -ErrorAction SilentlyContinue) {
  Write-Host "Setting GitHub repository variables on $Repo..."
  foreach ($k in $vars.Keys) { gh variable set $k --body $vars[$k] -R $Repo; Check "Setting variable $k" }
  Write-Host 'Enter the app registration client secret VALUE when prompted (it is stored as an encrypted GitHub secret):'
  gh secret set APP_CLIENT_SECRET -R $Repo; Check 'Setting secret APP_CLIENT_SECRET'
  Write-Host ''
  Write-Host 'Done. Push to main (or run the "Test and deploy" workflow manually) to deploy.'
} else {
  Write-Host ''
  Write-Host "GitHub CLI (gh) not found. In https://github.com/$Repo/settings/variables/actions add these repository VARIABLES:"
  foreach ($k in $vars.Keys) { Write-Host ("  {0} = {1}" -f $k, $vars[$k]) }
  Write-Host 'and under Secrets add one repository SECRET:'
  Write-Host '  APP_CLIENT_SECRET = <the app registration client secret VALUE>'
  Write-Host 'Then push to main (or run the "Test and deploy" workflow manually) to deploy.'
}
