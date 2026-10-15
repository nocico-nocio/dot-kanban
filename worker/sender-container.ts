import { Container } from "@cloudflare/containers";

export class SenderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
}
