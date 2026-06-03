/**
 * OfflineDB.ts
 * Manages task checklists per client matter using IndexedDB.
 */

export interface Task {
  id: string;
  clientId: number;
  title: string;
  completed: boolean;
  dueDate: string;
}

export interface Reminder {
  id: string;
  clientId: number;
  clientName: string;
  caseNumber: string;
  hearingDate: string;
  directive: string;
  notified: boolean;
  createdTime: number;
}

const DB_NAME = "NexusOfflineDB";
const STORE_NAME = "tasks";
const DB_VERSION = 2;

export class OfflineDB {
  private static openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error("IndexedDB open error");
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = (event: any) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("reminders")) {
          db.createObjectStore("reminders", { keyPath: "id" });
        }
      };
    });
  }

  public static async init(): Promise<boolean> {
    try {
      await OfflineDB.openDB();
      return true;
    } catch (e) {
      console.error("Failed to initialize tasks IndexedDB:", e);
      return false;
    }
  }

  public static async getTasksForClient(clientId: number): Promise<Task[]> {
    const db = await OfflineDB.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const allTasks: Task[] = request.result || [];
        const clientTasks = allTasks.filter(t => t.clientId === clientId);
        resolve(clientTasks);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  public static async saveTask(task: Task): Promise<void> {
    const db = await OfflineDB.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(task);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  public static async saveTasks(tasks: Task[]): Promise<void> {
    const db = await OfflineDB.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      
      transaction.oncomplete = () => {
        resolve();
      };
      
      transaction.onerror = () => {
        reject(transaction.error);
      };

      tasks.forEach(task => {
        store.put(task);
      });
    });
  }

  public static async deleteTask(taskId: string): Promise<void> {
    const db = await OfflineDB.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(taskId);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Generates auto-suggested core legal tasks based on case type
   */
  public static generateDefaultTasks(clientId: number, caseType: string, baseDateStr: string): Task[] {
    const tasks: Task[] = [];
    const baseDate = baseDateStr ? new Date(baseDateStr) : new Date("2026-06-15");
    
    // Helper to calculate relative date
    const relativeDateString = (daysOffset: number): string => {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + daysOffset);
      if (isNaN(d.getTime())) return baseDateStr || "2026-06-15";
      return d.toISOString().split("T")[0];
    };

    if (caseType === "property" || caseType === "os") {
      // OS / Civil Property case
      tasks.push({
        id: `t_${clientId}_1`,
        clientId,
        title: "File plaint & serve summons to opposite parties",
        completed: false,
        dueDate: relativeDateString(-15)
      });
      tasks.push({
        id: `t_${clientId}_2`,
        clientId,
        title: "Submit Survey commission petition with boundaries specified",
        completed: false,
        dueDate: relativeDateString(-10)
      });
      tasks.push({
        id: `t_${clientId}_3`,
        clientId,
        title: "File Written Statement / Objections to survey commission",
        completed: false,
        dueDate: relativeDateString(-5)
      });
      tasks.push({
        id: `t_${clientId}_4`,
        clientId,
        title: "Attend framing of issues & present schedule of documents",
        completed: false,
        dueDate: baseDateStr
      });
    } else if (caseType === "criminal" || caseType === "cc") {
      // Criminal Defense
      tasks.push({
        id: `t_${clientId}_1`,
        clientId,
        title: "File criminal bail application under Sec 437/439 CrPC or BNSS",
        completed: false,
        dueDate: relativeDateString(-7)
      });
      tasks.push({
        id: `t_${clientId}_2`,
        clientId,
        title: "File discharge petition & verify police chargesheet / FIR sections",
        completed: false,
        dueDate: relativeDateString(-3)
      });
      tasks.push({
        id: `t_${clientId}_3`,
        clientId,
        title: "Attend court trial for cross-examining prosecuting officer",
        completed: false,
        dueDate: baseDateStr
      });
    } else {
      // Other cases
      tasks.push({
        id: `t_${clientId}_1`,
        clientId,
        title: "Review case file indices and historical citations",
        completed: false,
        dueDate: relativeDateString(-5)
      });
      tasks.push({
        id: `t_${clientId}_2`,
        clientId,
        title: "Conduct pre-trial consultation/conference with client",
        completed: false,
        dueDate: relativeDateString(-1)
      });
      tasks.push({
        id: `t_${clientId}_3`,
        clientId,
        title: "Prepare oral arguments and submit written brief/synopsis",
        completed: false,
        dueDate: baseDateStr
      });
    }

    return tasks;
  }

  public static async getReminders(): Promise<Reminder[]> {
    const db = await OfflineDB.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("reminders", "readonly");
      const store = transaction.objectStore("reminders");
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  public static async saveReminder(reminder: Reminder): Promise<void> {
    const db = await OfflineDB.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("reminders", "readwrite");
      const store = transaction.objectStore("reminders");
      const request = store.put(reminder);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }
}
