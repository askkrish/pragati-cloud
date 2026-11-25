#!/usr/bin/env bash
# One-time preparation of an Azure subscription for the Pragati Cloud pilot. Run in Azure Cloud Shell
# by the subscription owner. It creates no running services and costs nothing on its own beyond a
# few paise of storage for the Terraform state.
#
#   1. registers the Azure services the pilot uses
#   2. creates two resource groups: rg-pragati-pilot (the pilot) and rg-pragati-tfstate (Terraform state)
#   3. creates the deployment identity "pragati-cloud-github-deploy". It has no password or key:
#      only GitHub Actions runs of askkrish/pragati-cloud in the "pilot" environment can use it,
#      and it can act only inside rg-pragati-pilot and the state storage.
set -euo pipefail
SUB=326ad94b-cd4a-4d88-82eb-b931b1414725
LOC=centralindia
TFSA=pragatitfd7i0sk
# GitHub sends either form of the repository identity in its token; trust both.
SUBJECTS=("repo:askkrish/pragati-cloud:environment:pilot" "repo:askkrish@268327612/pragati-cloud@1471499440:environment:pilot")

az account set --subscription "$SUB"
echo "Registering services (a few minutes)..."
for p in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL Microsoft.OperationalInsights \
         Microsoft.Storage Microsoft.Network Microsoft.ManagedIdentity Microsoft.Insights; do
  az provider register --namespace "$p" --wait &
done
wait

az group create -n rg-pragati-pilot -l "$LOC" --tags product=pragati-cloud -o none
az group create -n rg-pragati-tfstate -l "$LOC" --tags product=pragati-cloud -o none
az storage account create -n "$TFSA" -g rg-pragati-tfstate -l "$LOC" --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access false --allow-shared-key-access false -o none
az storage container-rm create --storage-account "$TFSA" -g rg-pragati-tfstate -n tfstate -o none

APP=$(az ad app list --display-name pragati-cloud-github-deploy --query "[0].appId" -o tsv)
if [ -z "$APP" ]; then APP=$(az ad app create --display-name pragati-cloud-github-deploy --query appId -o tsv); fi
az ad sp show --id "$APP" -o none 2>/dev/null || az ad sp create --id "$APP" -o none
for i in "${!SUBJECTS[@]}"; do
  SUBJECT=${SUBJECTS[$i]}
  if ! az ad app federated-credential list --id "$APP" --query "[?subject=='$SUBJECT'].name" -o tsv | grep -q .; then
    az ad app federated-credential create --id "$APP" --parameters "{\"name\":\"github-pilot-$i\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"$SUBJECT\",\"audiences\":[\"api://AzureADTokenExchange\"]}" -o none
  fi
done
SP=$(az ad sp show --id "$APP" --query id -o tsv)
RG=$(az group show -n rg-pragati-pilot --query id -o tsv)
STATE=$(az storage account show -n "$TFSA" -g rg-pragati-tfstate --query id -o tsv)
for role in Contributor "Role Based Access Control Administrator"; do
  az role assignment create --assignee-object-id "$SP" --assignee-principal-type ServicePrincipal --role "$role" --scope "$RG" -o none
done
az role assignment create --assignee-object-id "$SP" --assignee-principal-type ServicePrincipal --role "Storage Blob Data Contributor" --scope "$STATE" -o none

echo
echo "PILOT_READY client_id=$APP tenant_id=$(az account show --query tenantId -o tsv)"
