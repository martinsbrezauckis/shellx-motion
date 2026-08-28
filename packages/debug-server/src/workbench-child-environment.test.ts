import { describe, expect, it } from "vitest";
import { workbenchChildEnvironment, workbenchDesktopChildEnvironment } from "./workbench-child-environment";

describe("Workbench child environments", () => {
  it("withholds capability-bearing values by default and makes the desktop X11 exception explicit", () => {
    const source = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/operator",
      SSH_AUTH_SOCK: "/run/user/1000/ssh-agent",
      KRB5CCNAME: "FILE:/tmp/krb5cc",
      GPG_AGENT_INFO: "/run/user/1000/gnupg/S.gpg-agent",
      KUBECONFIG: "/home/operator/.kube/config",
      XAUTHORITY: "/home/operator/.Xauthority",
      DOCKER_CONFIG: "/home/operator/.docker"
    };
    const ordinary = workbenchChildEnvironment(source);
    const desktop = workbenchDesktopChildEnvironment(source);

    expect(ordinary).toMatchObject({ PATH: source.PATH, HOME: source.HOME });
    for (const name of ["SSH_AUTH_SOCK", "KRB5CCNAME", "GPG_AGENT_INFO", "KUBECONFIG", "XAUTHORITY", "DOCKER_CONFIG"]) {
      expect(ordinary, name).not.toHaveProperty(name);
    }
    expect(desktop.XAUTHORITY).toBe(source.XAUTHORITY);
    for (const name of ["SSH_AUTH_SOCK", "KRB5CCNAME", "GPG_AGENT_INFO", "KUBECONFIG", "DOCKER_CONFIG"]) {
      expect(desktop, name).not.toHaveProperty(name);
    }
  });
});
