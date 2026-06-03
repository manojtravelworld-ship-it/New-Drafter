/**
 * Mock LocalDB implementation using LocalStorage to satisfy the AdvocatePortal interface.
 */
export class LocalDB {
  private static instance: LocalDB;
  private data: Record<string, any[]> = {
    clients: []
  };

  private constructor() {}

  public static getInstance(): LocalDB {
    if (!LocalDB.instance) {
      LocalDB.instance = new LocalDB();
    }
    return LocalDB.instance;
  }

  public async init() {
    const saved = localStorage.getItem('nexus_db');
    if (saved) {
      this.data = JSON.parse(saved);
    }
    return true;
  }

  public query(sql: string): any[] {
    if (sql.toLowerCase().includes('from clients')) {
      return this.data.clients || [];
    }
    return [];
  }

  public run(sql: string, params: any[]) {
    if (sql.toLowerCase().includes('insert into clients')) {
      const [name, phone, case_number, court, next_date, purpose, case_type, extra_fields] = params;
      const newClient = {
        id: Date.now(),
        name,
        phone,
        case_number,
        court,
        next_date,
        purpose,
        case_type: case_type || 'other',
        extra_fields: extra_fields || {}
      };
      this.data.clients.push(newClient);
      this.persist();
    } else if (sql.toLowerCase().includes('update clients')) {
      // Expecting parameters: [case_number, court, next_date, purpose, extra_fields, id]
      const [case_number, court, next_date, purpose, extra_fields, id] = params;
      this.data.clients = this.data.clients.map(c => {
        if (c.id === Number(id)) {
          return {
            ...c,
            case_number: case_number !== undefined ? case_number : c.case_number,
            court: court !== undefined ? court : c.court,
            next_date: next_date !== undefined ? next_date : c.next_date,
            purpose: purpose !== undefined ? purpose : c.purpose,
            extra_fields: extra_fields !== undefined ? extra_fields : c.extra_fields
          };
        }
        return c;
      });
      this.persist();
    }
  }

  private persist() {
    localStorage.setItem('nexus_db', JSON.stringify(this.data));
  }
}
