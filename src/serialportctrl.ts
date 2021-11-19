import { execFileSync } from "child_process";
import * as os from "os";
import * as path from "path";

interface ISerialPortDetail {
  port: string;
  desc: string;
  hwid: string;
  vendorId: string;
  productId: string;
}

export class SerialPortCtrl {
  
  public static list(extensionPath: String): Promise<ISerialPortDetail[]> {
    const stdout = execFileSync(SerialPortCtrl._serialCliPath(extensionPath), ["list-ports"]);
    const lists = JSON.parse(stdout.toString("utf-8"));
    lists.forEach((port: { [x: string]: any; }) => {
        const vidPid = this._parseVidPid(port["hwid"]);
        port["vendorId"] = vidPid["vid"];
        port["productId"] = vidPid["pid"];
    });
    return lists;
  }

  private static _parseVidPid(hwid: String): any {
    const result = hwid.match(/VID:PID=(?<vid>\w+):(?<pid>\w+)/i);
    return result !== null ? result["groups"] : [null, null];
  }

  private static _serialCliPath(extensionPath: String): string {
    let fileName: string = "";
    if (os.platform() === "win32") {
        fileName = "main.exe";
    } else if (os.platform() === "linux" || os.platform() === "darwin") {
        fileName = "main";
    }
    
    return path.resolve(extensionPath.toString(), "serial-monitor-cli", `${os.platform}`, fileName);
  }
}