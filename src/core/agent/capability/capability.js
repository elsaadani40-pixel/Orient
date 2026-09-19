class Capability {
  constructor({
    name,
    description = '',
    risk = 'low'
  } = {}) {
    if (!name) {
      throw new Error('Capability name is required');
    }

    this.name = name;
    this.description = description;
    this.risk = risk;
  }

  toJSON() {
    return {
      name: this.name,
      description: this.description,
      risk: this.risk
    };
  }
}

module.exports = Capability;
