import { installProjectFileServices, projectFileServicesStarted } from "../application/formats/project-file-services.ts";
import { legacyProjectFileServices } from "../js/20d-formats.js";

if (!projectFileServicesStarted()) installProjectFileServices(legacyProjectFileServices());
