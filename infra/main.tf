terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.90"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }
}

provider "azurerm" {
  features {
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}

# Generate a random suffix for globally unique resource names
resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

# -----------------------------------------------------------------------------
# 1. Resource Group
# -----------------------------------------------------------------------------
resource "azurerm_resource_group" "rg" {
  name     = "rg-slate-app-v2"
  location = "eastus2"

  tags = {
    project = "slate-cloud-project"
  }
}

# -----------------------------------------------------------------------------
# 2. Storage Account & Storage Queue
# -----------------------------------------------------------------------------
resource "azurerm_storage_account" "sa" {
  name                     = "stslateapp${random_string.suffix.result}"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "LRS"

  tags = azurerm_resource_group.rg.tags
}

resource "azurerm_storage_queue" "activity_events" {
  name                 = "activity-events"
  storage_account_name = azurerm_storage_account.sa.name
}

# -----------------------------------------------------------------------------
# 3. Cosmos DB Account (Serverless), SQL API Database, and Containers
# -----------------------------------------------------------------------------
resource "azurerm_cosmosdb_account" "cosmos" {
  name                = "cosmos-slate-app-${random_string.suffix.result}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = azurerm_resource_group.rg.location
    failover_priority = 0
  }

  tags = azurerm_resource_group.rg.tags
}

resource "azurerm_cosmosdb_sql_database" "slate_db" {
  name                = "slate-db"
  resource_group_name = azurerm_resource_group.rg.name
  account_name        = azurerm_cosmosdb_account.cosmos.name
}

resource "azurerm_cosmosdb_sql_container" "logs" {
  name                = "logs"
  resource_group_name = azurerm_resource_group.rg.name
  account_name        = azurerm_cosmosdb_account.cosmos.name
  database_name       = azurerm_cosmosdb_sql_database.slate_db.name
  partition_key_paths = ["/userId"]
}

resource "azurerm_cosmosdb_sql_container" "feed" {
  name                = "feed"
  resource_group_name = azurerm_resource_group.rg.name
  account_name        = azurerm_cosmosdb_account.cosmos.name
  database_name       = azurerm_cosmosdb_sql_database.slate_db.name
  partition_key_paths = ["/ownerId"]
}

# -----------------------------------------------------------------------------
# 4. Windows Function App (Consumption Plan, Node.js 18)
# -----------------------------------------------------------------------------
resource "azurerm_service_plan" "asp" {
  name                = "asp-slate-app"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  os_type             = "Windows"
  sku_name            = "Y1"

  tags = azurerm_resource_group.rg.tags
}

resource "azurerm_windows_function_app" "function_app" {
  name                       = "func-slate-app-${random_string.suffix.result}"
  resource_group_name        = azurerm_resource_group.rg.name
  location                   = azurerm_resource_group.rg.location
  storage_account_name       = azurerm_storage_account.sa.name
  storage_account_access_key = azurerm_storage_account.sa.primary_access_key
  service_plan_id            = azurerm_service_plan.asp.id

  site_config {
    application_stack {
      node_version = "~18"
    }
  }

  tags = azurerm_resource_group.rg.tags
}

# -----------------------------------------------------------------------------
# 5. Azure Static Web App (Free Tier)
# -----------------------------------------------------------------------------
resource "azurerm_static_web_app" "swa" {
  name                = "swa-slate-app-${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  sku_tier            = "Free"
  sku_size            = "Free"

  tags = azurerm_resource_group.rg.tags
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "resource_group_name" {
  description = "The name of the Azure Resource Group"
  value       = azurerm_resource_group.rg.name
}

output "storage_account_name" {
  description = "The name of the Storage Account"
  value       = azurerm_storage_account.sa.name
}

output "storage_queue_name" {
  description = "The name of the Storage Queue"
  value       = azurerm_storage_queue.activity_events.name
}

output "cosmosdb_account_name" {
  description = "The name of the Cosmos DB Account"
  value       = azurerm_cosmosdb_account.cosmos.name
}

output "cosmosdb_database_name" {
  description = "The name of the Cosmos DB SQL Database"
  value       = azurerm_cosmosdb_sql_database.slate_db.name
}

output "cosmosdb_logs_container_name" {
  description = "The name of the Cosmos DB logs container"
  value       = azurerm_cosmosdb_sql_container.logs.name
}

output "cosmosdb_feed_container_name" {
  description = "The name of the Cosmos DB feed container"
  value       = azurerm_cosmosdb_sql_container.feed.name
}

output "service_plan_name" {
  description = "The name of the App Service Plan"
  value       = azurerm_service_plan.asp.name
}

output "function_app_name" {
  description = "The name of the Windows Function App"
  value       = azurerm_windows_function_app.function_app.name
}

output "static_web_app_name" {
  description = "The name of the Azure Static Web App"
  value       = azurerm_static_web_app.swa.name
}
