import { ComposeView } from "@inboxsdk/core";
import { EmailNotificationEvent, EventType, Flag } from "../../../common/types/events.types";
import { PrrUserAction } from "../../../common/enum/prrAction";
import { EmailMessage } from "../../../common/types/EmailMessage";
import { ComposeOption } from "../InBoxSdkHandler";
import { InboxBackgroundCommunicator } from "./InboxBackgroundCommunicator";
import { IInboxEventHandler } from "./InBoxEventHandler";
import { IdleTimer } from "./IdleTimer";
import { IInboxDialogs } from "./InboxDialogs";
import { DOMUtils } from "../utils/DOMUtils";
import { v4 as uuidv4 } from 'uuid';

export class InBoxComposeViewHandler {
  set modelRunner(value: InboxBackgroundCommunicator) {
    this._modelRunner = value;
  }

  private maxForcedRetries = 0;
  private _threadId = "sf-" + uuidv4();
  private messsageClean: boolean = false;
  private _attemptsToChangeMessage: number = 0;
  private _modelRunner: InboxBackgroundCommunicator;
  private prrDialog: IInboxDialogs;
  private eventHandler: IInboxEventHandler;
  private idleTimer: IdleTimer;
  private interval: any;
  private oldComposeText: string;
  private composeView: ComposeView | null;

  constructor(modelRunner: InboxBackgroundCommunicator, prrDialog: IInboxDialogs, eventHandler: IInboxEventHandler) {
    this._modelRunner = modelRunner;
    this.eventHandler = eventHandler;
    this.prrDialog = prrDialog;
  }

  register(composeView: ComposeView) {
    const myself = this;
    //run to monitor keyboard changes
    this.idleTimer = new IdleTimer(3000, composeView, async () => {
      const newComposeText = composeView.getTextContent();
      if (this.oldComposeText != newComposeText) {
        this.messsageClean = false;
        this.oldComposeText = newComposeText;
        await this.highlightToxicText(composeView);
      }
    });
    this.idleTimer.startMonitoring();

    //add button to check compose message
    composeView.addButton({
      title: 'Check Language',
      iconUrl: chrome.runtime.getURL('public/images/icons/icon64.png'),
      //@typescript-eslint/no-unused-vars
      onClick() {
        myself.highlightToxicText(composeView);
      }
    });

    composeView.on("presending", function (event) {
      myself.onInBoxCompose(composeView, event);
    });

    composeView.on("bodyChanged", function () {
      if (myself.composeView == null) {
        myself.composeView = composeView;
      }

      myself.onInBoxComposeBodyChange(composeView);
    });

    composeView.on("destroy", function () {
      myself.composeView = null;

      //reset on destroy
      myself.resetParams();

      if (myself.interval != null) {
        clearInterval(myself.interval);
      }
    });

  }

  onInBoxComposeBodyChange(composeView: ComposeView): void {
    this.composeView = composeView;
  }

  resetParams() {
    this.messsageClean = false;
    this._attemptsToChangeMessage = 0;
    this._threadId = "sf-" + uuidv4();
  }

  async onInBoxCompose(composeView: ComposeView, event: any): Promise<void> {
    if (!this.messsageClean) {
      event.cancel();
    }

    if (this.messsageClean) {
      this.resetParams();
      return;
    }

    const message = { subject: composeView.getSubject(), body: composeView.getTextContent() };
    const toxic = await this._modelRunner.isToxicAsync(null, null, message.subject + "." + message.body, 300, true);

    if (!toxic) {
      console.log("Clean Compose:" + message.subject + "." + message.body);
      if (composeView.destroyed) {
        this.resetParams();
        return;
      }

      const emailEvent: EmailNotificationEvent = {
        eventTypeId: EventType.EMAIL_SEND_EVENT
      }
      emailEvent.mlFlag = Flag.KIND
      emailEvent.threadId = this._threadId;
      this.eventHandler.notifyActivity(emailEvent)

      //reset params
      //this.resetParams();
      this.messsageClean = true;
      composeView.send();
    } else {
      this.messsageClean = false;
      if (composeView.destroyed) {
        this.resetParams();
        return;
      }
      event.mlFlag = Flag.UNKIND

      await this.highlightToxicText(composeView);

      const forceToChangeMessage = (this._attemptsToChangeMessage < this.maxForcedRetries);
      const prrResponse = forceToChangeMessage ? await this.prrDialog.doPRRComposeForceChange() :
        await this.prrDialog.doPRRComposeSendItAnyway();
      this._attemptsToChangeMessage++;

      const emailEvent: EmailNotificationEvent = {
        eventTypeId: EventType.EMAIL_SEND_EVENT,
        prrTriggered: true,
        threadId: this._threadId,
        mlFlag: Flag.UNKIND
      }
      switch (prrResponse) {
        case ComposeOption.MISTAKE: {
          emailEvent.prrMessage = "Yes, it's fine";
          emailEvent.userFlag = Flag.KIND;
          emailEvent.prrAction = PrrUserAction.COMPOSE_ACTION_YES_ITS_FINE;
          emailEvent.emailMessage = new EmailMessage(null, null, message.subject, message.body);
          this.eventHandler.notifyActivity(emailEvent);
          this.messsageClean = true;
          composeView.send();
          break;
        }
        case ComposeOption.NO_MISTAKE: {
          emailEvent.prrAction = PrrUserAction.COMPOSE_ACTION_NO_TRY_AGAIN;
          emailEvent.prrMessage = "No, let me try again";
          if (!forceToChangeMessage) {
            emailEvent.userFlag = Flag.UNKIND;
          }
          this.eventHandler.notifyActivity(emailEvent);
          break;
        }
      }
      //this.highlightToxicText(composeView); //run highlight while user decides
    }
  }

  private dismissedText = new Set<String>();

  async highlightToxicText(_composeView: ComposeView) {
    const textContent: string = _composeView.getTextContent();
    const htmlRoot: HTMLElement = _composeView.getBodyElement();
    const nodes: Set<Node> = new Set<Node>();
    const nodesToHighlight: Set<Node> = new Set<Node>();
    DOMUtils.getChildElements(nodes, htmlRoot);

    for (const node of nodes) {
      //console.log("Node:" + node.nodeName + "->" + node.nodeType);
      if (node.nodeType == Node.TEXT_NODE) {
        const plainText = node.textContent.replace(/\n/g, "").trim();
        if (!this.dismissedText.has(plainText)) {
          const toxic = await this._modelRunner.isToxicAsync(null, null, plainText, 100, true);
          if (toxic) {
            nodesToHighlight.add(node);
          }
        }
      }
    }


    //if something changed ignore the update
    if (textContent != _composeView.getTextContent()) {
      return;
    }

    //remove all dom toxic elements
    for (const node of nodes) {
      if (node.nodeType == Node.TEXT_NODE) {
        if (node.parentNode instanceof HTMLElement) {
          const htmlNode = node.parentNode as HTMLElement;
          if (htmlNode.classList.contains("sk_toxic")) {
            htmlNode.classList.remove("sk_toxic");
          }
        }
      }
    }

    //add toxic span
    for (const node of nodesToHighlight) {
      //console.log("Highlighting  node text:" + node.textContent);
      if (node.parentNode instanceof HTMLElement) {
        const htmlElement = node.parentNode as HTMLElement;
        //console.log("Parent node is " + htmlElement.tagName);
        //did we insert this ourselves
        if (htmlElement.classList.contains("sk_modify")) {
          htmlElement.classList.add("sk_toxic");
        } else {
          //create a new span
          const span = document.createElement("span");
          span.classList.add("sk_toxic", "sk_modify");
          node.parentNode.insertBefore(span, node);
          span.appendChild(node);
        }
      }
    }

    document.querySelectorAll(".sk_toxic").forEach(item => {
      const handleMouseEnter = () => {
        console.log("MOUSE EVENT ALIVE");
        // Create hover panel
        const panel = document.createElement('div');
        panel.className = 'hover-panel';

        // Add content
        const content = document.createElement('div');
        content.className = "hover-panel-content";
        content.textContent = "This sentence doesn't look kind";

        // Add button
        const button = document.createElement('button');
        button.className = 'hover-panel-button';
        button.textContent = '🗑️Dismiss';
        // Add logo
        const logo = document.createElement('div');
        logo.className = 'hover-panel-logo';
        const logoSvg = `<svg width="100" height="19" viewBox="0 0 150 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4.58406 22.7217C4.71215 22.923 5.00495 23.106 5.46244 23.2707C5.93823 23.4354 6.41402 23.5177 6.88981 23.5177C7.64009 23.5177 8.20738 23.3622 8.59167 23.0511C8.99426 22.7217 9.19556 22.3008 9.19556 21.7884C9.19556 21.2394 8.93937 20.7911 8.42698 20.4434C7.91459 20.0774 7.0728 19.6382 5.90163 19.1258L4.85855 18.6592C3.66907 18.1285 2.77239 17.488 2.16851 16.7377C1.58292 15.9691 1.29012 14.9993 1.29012 13.8281C1.29012 12.9863 1.53717 12.236 2.03126 11.5772C2.52535 10.9001 3.23903 10.3695 4.17231 9.98516C5.1056 9.60087 6.20357 9.40872 7.46625 9.40872C8.34463 9.40872 9.10406 9.46362 9.74455 9.57342C10.385 9.68321 11.0347 9.82046 11.6935 9.98516C12.1327 10.1133 12.462 10.1865 12.6816 10.2048V13.9379H10.2386L9.52495 11.8243C9.43346 11.6596 9.21386 11.5132 8.86617 11.3851C8.51847 11.2387 8.12503 11.1655 7.68584 11.1655C6.99046 11.1655 6.44147 11.321 6.03888 11.6321C5.63628 11.9249 5.43499 12.3275 5.43499 12.8399C5.43499 13.4255 5.66373 13.8921 6.12122 14.2398C6.57871 14.5692 7.3107 14.9627 8.31718 15.4201L8.89362 15.6672C10.3759 16.2894 11.5379 16.9665 12.3797 17.6985C13.2215 18.4121 13.6424 19.4003 13.6424 20.663C13.6424 22.0172 13.1025 23.1334 12.0229 24.0118C10.9432 24.8719 9.35111 25.3019 7.24665 25.3019C6.27677 25.3019 5.41669 25.2196 4.6664 25.0549C3.91612 24.9085 3.09264 24.7072 2.19595 24.451L1.29012 24.204L1.29012 20.5532H3.89782L4.58406 22.7217ZM15.2707 20.6081C15.2707 18.9977 16.085 17.7625 17.7137 16.9024C19.3606 16.0423 21.52 15.6031 24.1917 15.5848V15.0359C24.1917 14.3771 24.1185 13.8555 23.9721 13.4712C23.8258 13.0869 23.5604 12.8033 23.1761 12.6203C22.7918 12.419 22.2245 12.3184 21.4742 12.3184C20.5776 12.3184 19.7724 12.4282 19.0587 12.6478C18.3633 12.8491 17.6313 13.1235 16.8627 13.4712L15.9295 11.4949C16.2223 11.257 16.698 10.9733 17.3568 10.6439C18.0156 10.2963 18.8025 10.0035 19.7175 9.76556C20.6508 9.50937 21.6206 9.38127 22.6271 9.38127C24.0911 9.38127 25.2348 9.57342 26.0583 9.95771C26.9001 10.342 27.4948 10.9367 27.8425 11.7419C28.2085 12.5471 28.3915 13.6451 28.3915 15.0359V23.1883H29.8189V24.9177C29.398 25.0091 28.8124 25.1006 28.0621 25.1921C27.3118 25.2836 26.6713 25.3294 26.1407 25.3294C25.4453 25.3294 24.9786 25.2287 24.7407 25.0274C24.5211 24.8262 24.4113 24.4236 24.4113 23.8197V23.1883C23.9538 23.7373 23.3408 24.2314 22.5722 24.6706C21.8036 25.0915 20.9161 25.3019 19.9096 25.3019C19.0495 25.3019 18.2627 25.1189 17.549 24.753C16.8536 24.3687 16.2955 23.8288 15.8746 23.1334C15.472 22.4198 15.2707 21.578 15.2707 20.6081ZM22.0507 22.7766C22.3801 22.7766 22.7461 22.6851 23.1487 22.5021C23.5513 22.3008 23.899 22.0629 24.1917 21.7884V17.424C22.7644 17.424 21.703 17.6802 21.0076 18.1925C20.3305 18.7049 19.992 19.3637 19.992 20.1689C19.992 20.9924 20.175 21.6329 20.541 22.0904C20.907 22.5479 21.4102 22.7766 22.0507 22.7766ZM33.1214 12.0439H30.9803V10.342L33.1214 9.79301V8.64014C33.1214 7.41406 33.4508 6.29778 34.1096 5.2913C34.7684 4.28483 35.6467 3.48879 36.7447 2.9032C37.861 2.31762 39.0596 2.02482 40.3406 2.02482C41.0177 2.02482 41.6307 2.11632 42.1797 2.29932V6.27948C41.9784 6.05989 41.585 5.84944 40.9994 5.64815C40.4138 5.42855 39.8373 5.31876 39.2701 5.31876C38.6662 5.31876 38.2361 5.4743 37.9799 5.78539C37.7237 6.09649 37.5956 6.60888 37.5956 7.32256V9.76556H40.8896V12.0439H37.5956V22.9413L40.368 23.1883L40.368 25L31.0078 25V23.1883L33.1214 22.9413V12.0439ZM49.7307 25.3019C47.2236 25.3019 45.3662 24.5974 44.1584 23.1883C42.9506 21.761 42.3468 19.8212 42.3468 17.3691C42.3468 15.7038 42.6578 14.2673 43.28 13.0595C43.9022 11.8517 44.7715 10.9367 45.8877 10.3146C47.0223 9.67406 48.349 9.35382 49.8679 9.35382C51.7894 9.35382 53.2533 9.83876 54.2598 10.8086C55.2846 11.7785 55.8153 13.151 55.8519 14.9261C55.8519 16.0972 55.7695 17.0397 55.6048 17.7533H47.0132C47.1047 19.3088 47.4798 20.4983 48.1386 21.3218C48.8157 22.127 49.7581 22.5296 50.9659 22.5296C51.643 22.5296 52.3475 22.4198 53.0795 22.2002C53.8298 21.9623 54.4337 21.6969 54.8911 21.4041L55.6597 23.0785C55.1839 23.6092 54.3696 24.1125 53.2167 24.5883C52.0822 25.064 50.9201 25.3019 49.7307 25.3019ZM51.4874 15.9417L51.5149 14.7888C51.5149 13.6359 51.3593 12.7576 51.0482 12.1537C50.7371 11.5498 50.2064 11.2478 49.4562 11.2478C48.6876 11.2478 48.0928 11.5864 47.6719 12.2635C47.2511 12.9222 47.0223 14.1483 46.9857 15.9417L51.4874 15.9417ZM59.083 5.18151L57.2164 4.82467V3.15025L62.6789 2.49146H62.7612L63.5572 3.0679V15.8868L63.4749 17.2318L68.6354 11.7968L66.6041 11.4949V9.76556L74.0704 9.76556V11.4949L71.8195 11.8517L68.855 14.679L73.3841 22.9413L74.8115 23.1883V25L67.1806 25V23.1883L68.4158 22.9413L65.6983 17.5063L63.4749 19.8121L63.5298 21.212V22.9413L65.1219 23.1883V25H57.5733L57.5733 23.1883L59.083 22.9413V5.18151ZM78.969 7.37746C78.2553 7.37746 77.6789 7.16702 77.2397 6.74613C76.8005 6.32523 76.5809 5.7854 76.5809 5.12661C76.5809 4.35802 76.8188 3.72669 77.2946 3.2326C77.7887 2.73851 78.4475 2.49146 79.271 2.49146C80.0945 2.49146 80.7258 2.70191 81.165 3.1228C81.6042 3.54369 81.8238 4.08353 81.8238 4.74232C81.8238 5.5292 81.5767 6.16969 81.0826 6.66378C80.5885 7.13957 79.8932 7.37746 78.9965 7.37746H78.969ZM77.2946 12.6203L75.4555 12.0988V10.0401L80.9454 9.38127H81.0003L81.8512 9.95771V22.9413L83.4982 23.1883V25H75.5927V23.1883L77.2946 22.9413V12.6203ZM91.0864 25.3019C89.3297 25.3019 87.9023 24.6706 86.8043 23.4079C85.7064 22.1453 85.1574 20.2512 85.1574 17.7259C85.1574 16.207 85.4685 14.8163 86.0906 13.5536C86.7311 12.2726 87.6644 11.257 88.8905 10.5067C90.1349 9.73811 91.6354 9.35382 93.3922 9.35382C93.9229 9.35382 94.4719 9.41787 95.0392 9.54597V5.18151L92.404 4.79721V3.04045L98.4703 2.49146H98.6076L99.4311 3.15025V23.1609H100.858V24.9177C99.4494 25.1921 98.2782 25.3294 97.3449 25.3294C96.7044 25.3294 96.2378 25.2196 95.945 25C95.6705 24.7987 95.5333 24.3961 95.5333 23.7922V23.106C95.0941 23.7465 94.4627 24.2772 93.6392 24.6981C92.8158 25.1006 91.9648 25.3019 91.0864 25.3019ZM92.7334 22.8315C93.2458 22.8315 93.6941 22.7308 94.0784 22.5296C94.481 22.31 94.8013 22.0538 95.0392 21.761V11.8243C94.9111 11.6596 94.6732 11.5223 94.3255 11.4125C93.9961 11.3027 93.6392 11.2478 93.2549 11.2478C92.2302 11.2478 91.4158 11.7419 90.8119 12.7301C90.2081 13.7 89.9061 15.292 89.9061 17.5063C89.9061 19.318 90.1623 20.663 90.6747 21.5414C91.1871 22.4015 91.8733 22.8315 92.7334 22.8315ZM106.099 22.7217C106.227 22.923 106.52 23.106 106.977 23.2707C107.453 23.4354 107.929 23.5177 108.404 23.5177C109.155 23.5177 109.722 23.3622 110.106 23.0511C110.509 22.7217 110.71 22.3008 110.71 21.7884C110.71 21.2394 110.454 20.7911 109.942 20.4434C109.429 20.0774 108.587 19.6382 107.416 19.1258L106.373 18.6592C105.184 18.1285 104.287 17.488 103.683 16.7377C103.098 15.9691 102.805 14.9993 102.805 13.8281C102.805 12.9863 103.052 12.236 103.546 11.5772C104.04 10.9001 104.754 10.3695 105.687 9.98516C106.62 9.60087 107.718 9.40872 108.981 9.40872C109.859 9.40872 110.619 9.46362 111.259 9.57342C111.9 9.68321 112.549 9.82046 113.208 9.98516C113.647 10.1133 113.977 10.1865 114.196 10.2048V13.9379H111.753L111.04 11.8243C110.948 11.6596 110.729 11.5132 110.381 11.3851C110.033 11.2387 109.64 11.1655 109.2 11.1655C108.505 11.1655 107.956 11.321 107.554 11.6321C107.151 11.9249 106.95 12.3275 106.95 12.8399C106.95 13.4255 107.178 13.8921 107.636 14.2398C108.093 14.5692 108.825 14.9627 109.832 15.4201L110.408 15.6672C111.891 16.2894 113.053 16.9665 113.894 17.6985C114.736 18.4121 115.157 19.4003 115.157 20.663C115.157 22.0172 114.617 23.1334 113.538 24.0118C112.458 24.8719 110.866 25.3019 108.761 25.3019C107.791 25.3019 106.931 25.2196 106.181 25.0549C105.431 24.9085 104.607 24.7072 103.711 24.451L102.805 24.204V20.5532H105.412L106.099 22.7217ZM120.024 25.2196C119.402 25.2196 118.853 25 118.377 24.5608C117.92 24.1216 117.691 23.5818 117.691 22.9413C117.691 22.2093 117.957 21.6146 118.487 21.1571C119.018 20.6813 119.677 20.4434 120.464 20.4434C121.177 20.4434 121.754 20.6721 122.193 21.1296C122.632 21.5871 122.852 22.127 122.852 22.7491C122.852 23.5177 122.595 24.1216 122.083 24.5608C121.571 25 120.884 25.2196 120.024 25.2196ZM125.31 20.6081C125.31 18.9977 126.124 17.7625 127.753 16.9024C129.4 16.0423 131.559 15.6031 134.231 15.5848V15.0359C134.231 14.3771 134.158 13.8555 134.011 13.4712C133.865 13.0869 133.599 12.8033 133.215 12.6203C132.831 12.419 132.264 12.3184 131.513 12.3184C130.617 12.3184 129.811 12.4282 129.098 12.6478C128.402 12.8491 127.67 13.1235 126.902 13.4712L125.968 11.4949C126.261 11.257 126.737 10.9733 127.396 10.6439C128.055 10.2963 128.841 10.0035 129.756 9.76556C130.69 9.50937 131.66 9.38127 132.666 9.38127C134.13 9.38127 135.274 9.57342 136.097 9.95771C136.939 10.342 137.534 10.9367 137.882 11.7419C138.248 12.5471 138.43 13.6451 138.43 15.0359V23.1883H139.858V24.9177C139.437 25.0091 138.851 25.1006 138.101 25.1921C137.351 25.2836 136.71 25.3294 136.18 25.3294C135.484 25.3294 135.018 25.2287 134.78 25.0274C134.56 24.8262 134.45 24.4236 134.45 23.8197V23.1883C133.993 23.7373 133.38 24.2314 132.611 24.6706C131.843 25.0915 130.955 25.3019 129.949 25.3019C129.089 25.3019 128.302 25.1189 127.588 24.753C126.893 24.3687 126.334 23.8288 125.914 23.1334C125.511 22.4198 125.31 21.578 125.31 20.6081ZM132.09 22.7766C132.419 22.7766 132.785 22.6851 133.188 22.5021C133.59 22.3008 133.938 22.0629 134.231 21.7884V17.424C132.803 17.424 131.742 17.6802 131.047 18.1925C130.37 18.7049 130.031 19.3637 130.031 20.1689C130.031 20.9924 130.214 21.6329 130.58 22.0904C130.946 22.5479 131.449 22.7766 132.09 22.7766ZM144.698 7.37746C143.984 7.37746 143.407 7.16702 142.968 6.74613C142.529 6.32523 142.309 5.7854 142.309 5.12661C142.309 4.35802 142.547 3.72669 143.023 3.2326C143.517 2.73851 144.176 2.49146 144.999 2.49146C145.823 2.49146 146.454 2.70191 146.894 3.1228C147.333 3.54369 147.552 4.08353 147.552 4.74232C147.552 5.5292 147.305 6.16969 146.811 6.66378C146.317 7.13957 145.622 7.37746 144.725 7.37746H144.698ZM143.023 12.6203L141.184 12.0988V10.0401L146.674 9.38127H146.729L147.58 9.95771V22.9413L149.227 23.1883V25H141.321V23.1883L143.023 22.9413V12.6203Z" fill="#222224" />
                <circle cx="79" cy="4" r="4" fill="#FF2F4E" />
            </svg>`;
        logo.innerHTML = logoSvg;

        // Assemble panel
        panel.appendChild(content);
        panel.appendChild(button);
        panel.appendChild(logo);

        // Add panel to element
        item.appendChild(panel);

        // Create an invisible area between text and panel
        const buffer = document.createElement('div');
        buffer.style.position = 'absolute';
        buffer.style.top = '100%';
        buffer.style.left = '0';
        buffer.style.width = '100%';
        buffer.style.height = '8px'; // Same as margin-top of panel
        item.appendChild(buffer);

        // const rect = panel.getBoundingClientRect();

        // if (rect.right > window.innerWidth) {
        //   panel.style.left = 'auto';
        //   panel.style.right = '0';
        // }

        // if (rect.bottom > window.innerHeight) {
        //   panel.style.top = 'auto';
        //   panel.style.bottom = '100%';
        //   panel.style.marginTop = '0';
        //   panel.style.marginBottom = '8px';
        // }

        // Add hover handlers to keep panel visible
        let timeoutId = null;
        const hidePanel = () => {
          timeoutId = setTimeout(() => {
            if (panel && panel.parentNode) {
              panel.remove();
            }
            if (buffer && buffer.parentNode) {
              buffer.remove();
            }
          }, 500);
        };

        const cancelHide = () => {
          clearTimeout(timeoutId);
        };

        panel.addEventListener('mouseenter', cancelHide);
        panel.addEventListener('mouseleave', hidePanel);
        buffer.addEventListener('mouseenter', cancelHide);
        buffer.addEventListener('mouseleave', hidePanel);
        item.addEventListener('mouseleave', hidePanel);

        // Add click handler
        button.addEventListener('click', () => {
          item.classList.remove("sk_toxic");

          let originalText = '';

          // Find the text node (should be the first child due to how we structured it)
          if (item.firstChild && item.firstChild.nodeType === Node.TEXT_NODE) {
            originalText = item.firstChild.textContent;
          } else {
            // If somehow the structure is different, get text content excluding the panel
            originalText = Array.from(item.childNodes)
              .filter(node => node.nodeType === Node.TEXT_NODE)
              .map(node => node.textContent)
              .join('');
          }

          // Create new text node with original text only
          const textNode = document.createTextNode(originalText);

          // Replace the span with just the text
          if (item.parentNode) {
            item.parentNode.replaceChild(textNode, item);
            this.dismissedText.add(originalText.replace(/\n/g, "").trim());
          }

          // item.removeEventListener('mouseenter', handleMouseEnter);
          hidePanel();
        });
      }

      item.addEventListener('mouseenter', handleMouseEnter);
    });
  }

  get threadId(): string {
    return this._threadId;
  }

  get attemptsToChangeMessage(): number {
    return this._attemptsToChangeMessage;
  }
}
