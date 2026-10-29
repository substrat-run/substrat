function dot(registration: StoreDriverRegistration) {
  return registration.releases;
}

function optional(registration: StoreDriverRegistration) {
  return registration?.className;
}

function computed(registration: StoreDriverRegistration) {
  return registration['operations'];
}

function destructured(registration: StoreDriverRegistration) {
  const { platformOperations } = registration;
  return platformOperations;
}

function spread(registration: StoreDriverRegistration) {
  return { ...registration };
}

function helperParameter(value: StoreDriverRegistration) {
  return value.operations;
}

function arrayElement(registrations: readonly StoreDriverRegistration[]) {
  return registrations[0]?.releases;
}
export function pickProjection(registration: Pick<StoreDriverRegistration, 'releases'>) {
  return registration.releases;
}
