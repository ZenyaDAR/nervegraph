require 'json'
require_relative 'helper'

class Thing
  def to_s
    Helper.format(JSON.generate({}))
  end
end
