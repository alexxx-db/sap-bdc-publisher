# Databricks notebook source
dbutils.widgets.text("app_name", "")
dbutils.widgets.text("source_code_path", "")

app_name = dbutils.widgets.get("app_name")
source_code_path = dbutils.widgets.get("source_code_path")

assert app_name, "app_name parameter is required"
assert source_code_path, "source_code_path parameter is required"

# COMMAND ----------

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.apps import AppDeployment, ComputeState

w = WorkspaceClient()

app = w.apps.get(name=app_name)
if app.compute_status is None or app.compute_status.state != ComputeState.ACTIVE:
    print(f"Starting app '{app_name}' compute...")
    w.apps.start_and_wait(name=app_name)
    print("Compute is ACTIVE")
else:
    print("Compute already ACTIVE")

print(f"Deploying app '{app_name}' from {source_code_path}")
deployment = w.apps.deploy_and_wait(
    app_name=app_name,
    app_deployment=AppDeployment(source_code_path=source_code_path),
)
print(f"Deployment {deployment.deployment_id}: {deployment.status.state}")
print(deployment.status.message)
assert deployment.status.state.value == "SUCCEEDED", deployment.status.message
