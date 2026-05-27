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
from databricks.sdk.service.iam import (
    AccessControlRequest,
    PermissionLevel,
)

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

# COMMAND ----------

# Grant the app service principal CAN_READ on the bundle notebooks directory.
# The app's publish / unpublish routes submit Jobs that invoke
# `${workspace.file_path}/notebooks/bdc_publish` (and `bdc_unpublish`) as the
# SP. In `mode: development` the bundle files dir is owned by the deploying
# user with no implicit SP access, so the Job fails with
# "Unable to access the notebook ... lacks the required permissions" unless
# we grant it here.

sp_application_id = app.service_principal_client_id
assert sp_application_id, f"app '{app_name}' has no service_principal_client_id"

# source_code_path looks like `${workspace.file_path}/apps/<name>`; the
# notebooks live next to /apps/ at the bundle files root.
bundle_root = source_code_path.rsplit("/apps/", 1)[0]
notebooks_dir = f"{bundle_root}/notebooks"

status = w.workspace.get_status(path=notebooks_dir)
object_id = str(status.object_id)
print(f"Granting CAN_READ on {notebooks_dir} (object_id={object_id}) to SP {sp_application_id}")

w.permissions.update(
    request_object_type="directories",
    request_object_id=object_id,
    access_control_list=[
        AccessControlRequest(
            service_principal_name=sp_application_id,
            permission_level=PermissionLevel.CAN_READ,
        )
    ],
)
print("SP can now read the notebooks directory")
